// coach.js
//
// Takes an engine analysis (FEN + eval + best move) and asks Groq's LLM
// API to explain it in plain English. This is pure natural-language
// generation — the engine has already done all the actual chess
// calculation; the LLM's only job is to narrate it.

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile'; // free-tier, strong general model

/**
 * @param {object} analysis - output of UciEngine.analyze()
 * @param {string} analysis.bestMove - e.g. "d1d5"
 * @param {number} analysis.scoreCp - White-perspective centipawn eval
 * @param {string} fen - the position being explained
 * @param {string} apiKey - Groq API key (from console.groq.com)
 * @param {string} [classification] - optional move-quality label (Best/Good/Inaccuracy/Mistake/Blunder),
 *   from comparing this position to the one before the user's move
 * @param {number} [evaluationLoss] - optional centipawn loss for that move
 * @param {string} [playedMove] - optional SAN of the move the user actually played (e.g. "Qxd5"),
 *   so the explanation can name and contrast BOTH moves, not just narrate the recommended one
 * @returns {Promise<string>} plain-English explanation
 */
async function explainPosition({ bestMove, scoreCp, fen, apiKey, classification, evaluationLoss, playedMove }) {
  const sideToMove = fen.split(' ')[1] === 'w' ? 'White' : 'Black';
  const evalPawns = (scoreCp / 100).toFixed(2); // already White-perspective, no conversion needed

  const prompt = buildPrompt({ fen, sideToMove, bestMove, evalPawns, classification, evaluationLoss, playedMove });

  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are a chess coach explaining engine analysis to an intermediate club player. ' +
            'Be concise (3-5 sentences), concrete, and avoid vague filler like "this is a good move" ' +
            'without saying why. Reference actual squares and pieces. ' +
            'If a played move and a recommended move are both given, structure the answer as a direct ' +
            'comparison: name the recommended move and why it is stronger (what it develops, controls, or ' +
            'threatens), then name the played move and what it does or fails to do by contrast — the way a ' +
            'human coach would say "X is stronger because... your Y move does A but allows B." ' +
            'If only a classification and evaluation loss are given (no move names), open by naming the ' +
            'classification and approximate pawns lost, then explain why the position changed.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.4,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Groq API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return data.choices[0].message.content.trim();
}

function buildPrompt({ fen, sideToMove, bestMove, evalPawns, classification, evaluationLoss, playedMove }) {
  const lines = [
    `Position (FEN): ${fen}`,
    `Side to move: ${sideToMove}`,
    `Engine's recommended move (UCI notation, e.g. e2e4 means the piece on e2 moves to e4): ${bestMove}`,
    `Engine evaluation: ${evalPawns} (positive favors White, negative favors Black, in units of pawns)`,
  ];

  if (classification) {
    lines.push(
      '',
      playedMove
        ? `The user played ${playedMove} instead. Kestrel classifies that move as: ${classification}`
        : `The user just played a move. Kestrel classifies it as: ${classification}`,
      `Evaluation lost by that move: ${(evaluationLoss / 100).toFixed(2)} pawns`,
      '',
      playedMove
        ? `Compare ${playedMove} (what was played) against the recommended move directly — why is the recommendation stronger, and what does ${playedMove} miss or allow?`
        : 'Explain the classification and evaluation loss first, then why the engine\'s recommended move is better.'
    );
  } else {
    lines.push('', 'Explain why this is a strong move in this position, and briefly what the evaluation number means for whoever is winning.');
  }

  return lines.join('\n');
}

/**
 * Summarizes an entire analyzed game in plain English — one LLM call for
 * the whole game, not one per move, since a per-move explanation for
 * every ply would be slow and expensive for no real benefit (most moves
 * in a real game are unremarkable).
 *
 * @param {object} report - aggregated stats from the game analysis
 * @param {string} apiKey
 * @returns {Promise<string>}
 */
async function explainGame(report, apiKey) {
  const prompt = buildGameSummaryPrompt(report);

  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are a chess coach writing a short post-game summary for an intermediate club player. ' +
            'Write 4-6 sentences: overall impression, what went well, what to work on, and reference the ' +
            'critical moment by move number and the eval swing. Be direct and concrete, not generic praise.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.4,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Groq API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return data.choices[0].message.content.trim();
}

function buildGameSummaryPrompt(report) {
  const lines = [
    `White accuracy: ${report.accuracy.white}%`,
    `Black accuracy: ${report.accuracy.black}%`,
    `Opening: ${report.opening}`,
    `Move counts (White): ${JSON.stringify(report.counts.white)}`,
    `Move counts (Black): ${JSON.stringify(report.counts.black)}`,
  ];

  if (report.criticalMoment) {
    const c = report.criticalMoment;
    lines.push(
      `Critical moment: move ${c.moveNumber} (${c.color === 'w' ? 'White' : 'Black'}) played ${c.san}, ` +
        `eval swung from ${(c.evalBefore / 100).toFixed(2)} to ${(c.evalAfter / 100).toFixed(2)} (White-perspective pawns)`
    );
  }
  if (report.biggestBlunder) {
    const b = report.biggestBlunder;
    lines.push(`Biggest blunder: move ${b.moveNumber} (${b.color === 'w' ? 'White' : 'Black'}) ${b.san}`);
  }

  lines.push('', 'Write the post-game summary now.');
  return lines.join('\n');
}

module.exports = { explainPosition, explainGame };
