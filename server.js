// server.js
//
// HTTP API in front of the existing engine + coach logic (engine.js,
// coach.js). This is what the React frontend talks to — it never touches
// the engine process or the Groq API directly.

const express = require('express');
const cors = require('cors');
const { UciEngine } = require('./engine.js');
const { explainPosition, explainGame } = require('./coach.js');
const { classifyMove, computeAccuracy, normalizeScore } = require('./classify.js');
const { identifyOpening } = require('./openings.js');

const PORT = process.env.PORT || 3001;
const ENGINE_PATH = process.platform === 'win32' ? './kestrel.exe' : './kestrel';
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const app = express();
app.use(cors());
app.use(express.json());

// One long-lived engine process, reused across requests, rather than
// spawning a fresh one per call — spawning is the slow part, and the
// engine has no per-position state that would leak between analyses.
const engine = new UciEngine(ENGINE_PATH);
engine.start();

// POST /api/analyze
// Body: { fen: string, fenBefore?: string, playedMove?: string, movetimeMs?: number, explain?: boolean }
//   fenBefore is OPTIONAL — the position immediately before the move being
//   judged. When present, the response also includes move-quality fields
//   (scoreBefore, scoreAfter, evaluationLoss, classification, plus the
//   spec-named aliases playedMoveScore/bestMoveScore/evaluationDifference).
//   playedMove is an OPTIONAL SAN string (e.g. "Qxd5") — the frontend
//   already knows this from chess.js when the move was made; we just
//   echo it back so the response is a self-contained comparison object.
//   When fenBefore is absent, behavior is unchanged: just an analysis
//   of `fen` on its own.
// Returns: { bestMove, scoreCp, depth, nodes, explanation?,
//            scoreBefore?, scoreAfter?, evaluationLoss?, classification?,
//            playedMove?, playedMoveScore?, bestMoveScore?, evaluationDifference? }
app.post('/api/analyze', async (req, res) => {
  const { fen, fenBefore, playedMove, movetimeMs = 800, explain = true } = req.body;

  if (!fen || typeof fen !== 'string') {
    res.status(400).json({ error: 'Request body must include a "fen" string.' });
    return;
  }

  try {
    const analysis = await engine.analyze(fen, movetimeMs);
    const result = { ...analysis };

    let classification = null;
    if (fenBefore && typeof fenBefore === 'string') {
      // Two extra engine calls to bracket the move: eval right before it
      // was played, and eval right after (which we already have from
      // `analysis` above — `fen` IS the after-move position). Both are
      // already White-perspective centipawns (see engine.js), and already
      // normalized against forced-mate scores blowing up the numbers.
      //
      // Note on `before.scoreCp`: this is the root search's OWN reported
      // score for the before-position — which, by how minimax works, IS
      // the evaluation of the position that results from playing the
      // engine's own best move (the root score is literally derived from
      // searching every candidate move and reporting the best child's
      // score). So this single call already gives us both "eval of this
      // position" AND "eval after Kestrel's recommended move" — no third
      // engine call needed to evaluate "what if the best move were played".
      const before = await engine.analyze(fenBefore, movetimeMs);
      const scoreBefore = normalizeScore(before.scoreCp);
      const scoreAfter = normalizeScore(analysis.scoreCp);

      // Whoever moved is whoever was to move in the BEFORE position —
      // that's the player classify.js needs, not the side to move now.
      const mover = fenBefore.split(' ')[1] === 'b' ? 'b' : 'w';
      const { label, centipawnLoss, winProbLoss } = classifyMove(scoreBefore, scoreAfter, mover);

      classification = { scoreBefore, scoreAfter, evaluationLoss: centipawnLoss, classification: label };
      Object.assign(result, classification);
      result.winProbabilityLoss = winProbLoss; // percentage points, 0-100 — what classification is actually decided on

      // Once we're classifying a move, "bestMove" should mean "what the
      // user should have played instead" — that's the engine's top choice
      // from the BEFORE position. `analysis.bestMove` (from the AFTER
      // position) is actually the opponent's best reply now, which isn't
      // what "Kestrel preferred X instead" is supposed to mean. Override
      // it here rather than exposing two confusingly-similar fields.
      result.bestMove = before.bestMove;

      // Spec-named aliases for the move-comparison feature — same numbers
      // as scoreAfter/scoreBefore/evaluationLoss above, just named to
      // match "your move vs Kestrel's move" framing directly. Kept as
      // additions, not replacements, so nothing already reading
      // scoreBefore/scoreAfter/evaluationLoss/classification breaks.
      result.playedMove = typeof playedMove === 'string' ? playedMove : undefined;
      result.playedMoveScore = scoreAfter;
      result.bestMoveScore = scoreBefore;
      result.evaluationDifference = centipawnLoss;
    }

    if (explain) {
      if (!GROQ_API_KEY) {
        result.explanation = null;
        result.explanationError = 'GROQ_API_KEY not set on the server — analysis only, no explanation.';
      } else {
        result.explanation = await explainPosition({
          bestMove: result.bestMove, // may be before.bestMove if classifying — see above
          scoreCp: analysis.scoreCp,
          fen,
          apiKey: GROQ_API_KEY,
          classification: classification?.classification,
          evaluationLoss: classification?.evaluationLoss,
          playedMove: result.playedMove,
        });
      }
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', engineRunning: !!engine.process });
});

// POST /api/analyze-game
// Body: { positions: [{ moveNumber, color, san, fen }, ...], quickDepth?, deepMovetimeMs? }
//   positions[0] MUST be the starting position, with san/color/moveNumber
//   left null/undefined — it's the "before any moves" baseline eval.
//   Every entry after that is the position AFTER one ply.
//
// Streams newline-delimited JSON as it works, so the frontend can show
// live progress instead of blocking on one giant response:
//   {"type":"progress","phase":"quick"|"deep","index":N,"total":M}
//   {"type":"done","report":{...}}
//   {"type":"error","error":"..."}
//
// Two-pass strategy (see engine.js/classify.js for the "why"): every ply
// gets a fixed-DEPTH first pass (not time-boxed — see analyzeToDepth's
// docs for why depth matters more than time here) to build the eval curve
// and classify moves; only the flagged Mistake/Blunder positions then get
// a slower, deeper re-analysis. This keeps a full game's analysis time
// roughly linear in game length instead of exploding at max depth for
// every single position.
app.post('/api/analyze-game', async (req, res) => {
  const { positions, quickDepth = 4, deepMovetimeMs = 1000 } = req.body;

  if (!Array.isArray(positions) || positions.length < 2) {
    res.status(400).json({ error: 'Request body must include a "positions" array with at least a start position plus one move.' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Cache-Control': 'no-cache',
    'Transfer-Encoding': 'chunked',
  });
  const send = (obj) => res.write(JSON.stringify(obj) + '\n');

  try {
    const total = positions.length - 1; // number of actual half-moves
    const evals = new Array(positions.length);
    const bestMoves = new Array(positions.length);

    // Pass 1: fixed-depth eval at every ply, including the starting position
    // (index 0), which serves as the baseline the first move is judged
    // against. Fixed depth (not a time budget) is deliberate — Kestrel has
    // no quiescence search, so a too-shallow search can misjudge the
    // position right after a capture (it doesn't look far enough ahead to
    // see the recapture), producing wild eval swings that aren't real
    // mistakes. A guaranteed few plies of look-ahead sees the recapture
    // within the search itself, keeping ordinary trades from being
    // misclassified as blunders.
    for (let i = 0; i < positions.length; i++) {
      const result = await engine.analyzeToDepth(positions[i].fen, quickDepth);
      evals[i] = normalizeScore(result.scoreCp);
      bestMoves[i] = result.bestMove;
      if (i > 0) {
        send({ type: 'progress', phase: 'quick', index: i, total });
      }
    }

    // Classify every move by comparing the eval right before it was
    // played to the eval right after.
    const moveResults = [];
    for (let i = 1; i < positions.length; i++) {
      const { moveNumber, color, san } = positions[i];
      const { label, centipawnLoss, winProbLoss } = classifyMove(evals[i - 1], evals[i], color);
      moveResults.push({
        ply: i,
        moveNumber,
        color,
        san,
        evalBefore: evals[i - 1],
        evalAfter: evals[i],
        bestMoveBefore: bestMoves[i - 1],
        label,
        centipawnLoss,
        winProbLoss,
      });
    }

    // Pass 2: deeper re-analysis, but only for the moves that pass 1
    // flagged as Mistake or Blunder — this is what keeps the total
    // analysis time from exploding on a long game.
    const criticalMoves = moveResults.filter((m) => m.label === 'Mistake' || m.label === 'Blunder');
    for (let i = 0; i < criticalMoves.length; i++) {
      const m = criticalMoves[i];
      const posBeforeMove = positions[m.ply - 1].fen;
      const deep = await engine.analyze(posBeforeMove, deepMovetimeMs);
      m.deepBestMove = deep.bestMove;
      m.deepEvalBefore = normalizeScore(deep.scoreCp);
      send({ type: 'progress', phase: 'deep', index: i + 1, total: criticalMoves.length });
    }

    // Aggregate per-color stats.
    const colorMoves = (color) => moveResults.filter((m) => m.color === color);
    const countsFor = (color) => {
      const counts = { Best: 0, Good: 0, Inaccuracy: 0, Mistake: 0, Blunder: 0 };
      colorMoves(color).forEach((m) => counts[m.label]++);
      return counts;
    };

    const accuracy = {
      white: computeAccuracy(colorMoves('w').map((m) => m.winProbLoss)),
      black: computeAccuracy(colorMoves('b').map((m) => m.winProbLoss)),
    };
    const counts = { white: countsFor('w'), black: countsFor('b') };

    // Critical moment = the single largest eval swing among flagged moves.
    // Best move of the game = a "Best"-labeled move played in the most
    // pressured position available (largest |eval| beforehand) — a simple,
    // defensible stand-in for "the move that mattered most and was found".
    let criticalMoment = null;
    let biggestBlunder = null;
    let bestMoveOfGame = null;

    for (const m of moveResults) {
      if (m.label === 'Mistake' || m.label === 'Blunder') {
        if (!criticalMoment || m.winProbLoss > criticalMoment.winProbLoss) criticalMoment = m;
      }
      if (m.label === 'Blunder') {
        if (!biggestBlunder || m.winProbLoss > biggestBlunder.winProbLoss) biggestBlunder = m;
      }
      if (m.label === 'Best') {
        if (!bestMoveOfGame || Math.abs(m.evalBefore) > Math.abs(bestMoveOfGame.evalBefore)) bestMoveOfGame = m;
      }
    }

    const opening = identifyOpening(positions.slice(1).map((p) => p.san));

    const toPublic = (m) =>
      m && {
        moveNumber: m.moveNumber,
        color: m.color,
        san: m.san,
        evalBefore: m.evalBefore,
        evalAfter: m.evalAfter,
        centipawnLoss: m.centipawnLoss,
        winProbLoss: m.winProbLoss,
      };

    const report = {
      accuracy,
      counts,
      opening,
      criticalMoment: toPublic(criticalMoment),
      biggestBlunder: toPublic(biggestBlunder),
      bestMoveOfGame: toPublic(bestMoveOfGame),
      evalGraph: evals, // White-perspective eval per ply, index 0 = starting position
      moves: moveResults.map((m) => ({
        moveNumber: m.moveNumber,
        color: m.color,
        san: m.san,
        label: m.label,
        centipawnLoss: m.centipawnLoss,
        winProbLoss: m.winProbLoss,
        evalAfter: m.evalAfter,
        fen: positions[m.ply].fen,
      })),
    };

    send({ type: 'progress', phase: 'summary', index: total, total });

    if (GROQ_API_KEY) {
      try {
        report.summary = await explainGame(report, GROQ_API_KEY);
      } catch (err) {
        report.summaryError = err.message;
      }
    } else {
      report.summaryError = 'GROQ_API_KEY not set on the server — no summary generated.';
    }

    send({ type: 'done', report });
  } catch (err) {
    send({ type: 'error', error: err.message });
  } finally {
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Corvus API listening on http://localhost:${PORT}`);
  if (!GROQ_API_KEY) {
    console.warn('Warning: GROQ_API_KEY not set — explanations will be skipped.');
  }
});

// Make sure the engine child process doesn't outlive the server on shutdown.
process.on('SIGINT', () => {
  engine.stop();
  process.exit(0);
});
