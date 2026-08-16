// engine.js
//
// Thin wrapper around the compiled chess engine binary (kestrel / kestrel.exe).
// Spawns it as a child process and speaks the UCI protocol over its
// stdin/stdout — the same protocol any chess GUI would use, so nothing
// engine-specific leaks into the rest of the coach layer.

const { spawn } = require('child_process');

class UciEngine {
  /**
   * @param {string} enginePath - path to the compiled engine binary
   *   (e.g. "./kestrel.exe" on Windows, "./kestrel" on Mac/Linux).
   */
  constructor(enginePath) {
    this.enginePath = enginePath;
    this.process = null;
    // Every analyze() call chains onto this promise instead of running
    // immediately. That guarantees only one "position ... / go ..." pair
    // is ever in flight against the engine's stdin/stdout at a time — if
    // two requests arrive close together (a double-click, a page reload
    // that leaves a stale request in flight, etc.) the second one simply
    // waits its turn instead of interleaving with the first and corrupting
    // both parses, which is what caused the "stuck until server restart"
    // hang.
    this.queue = Promise.resolve();
  }

  start() {
    this.process = spawn(this.enginePath);
    this.process.stdout.setEncoding('utf8');

    // Guard against the engine binary not existing/failing to launch —
    // without this, a missing exe fails silently and every analyze()
    // call just hangs waiting for output that never comes.
    this.process.on('error', (err) => {
      throw new Error(`Failed to start engine at "${this.enginePath}": ${err.message}`);
    });
  }

  stop() {
    if (this.process) {
      this.process.stdin.write('quit\n');
      this.process.kill();
      this.process = null;
    }
  }

  /**
   * Sends a FEN position to the engine and asks it to think for the given
   * time budget. Resolves with the parsed evaluation once "bestmove" arrives.
   * Safe to call concurrently — requests are queued and run one at a time.
   *
   * @param {string} fen
   * @param {number} movetimeMs - how long the engine should think
   * @returns {Promise<{bestMove: string, scoreCp: number, depth: number, nodes: number}>}
   *   scoreCp is always White-perspective (positive favors White), regardless
   *   of whose turn it is in `fen` — NOT the raw UCI side-to-move-relative value.
   */
  analyze(fen, movetimeMs = 1000) {
    return this._enqueue(fen, `go movetime ${movetimeMs}`, movetimeMs + 5000);
  }

  /**
   * Same as analyze(), but searches to a FIXED depth instead of a time
   * budget ("go depth N"). Use this when you need a guaranteed minimum
   * amount of look-ahead regardless of hardware speed — in particular,
   * a too-shallow time-boxed search can misjudge the position right
   * after a capture, because it never looks far enough ahead to see the
   * recapture coming (no quiescence search in this engine — see
   * classify.js / server.js comments on why the "quick pass" for game
   * analysis switched to this). No time budget here means worst-case
   * runtime is bounded by depth alone, so keep depth modest for bulk use.
   *
   * @param {string} fen
   * @param {number} depth - plies to search, fully (not time-limited)
   */
  analyzeToDepth(fen, depth = 4) {
    // Untimed searches have no natural upper bound the way a movetime
    // search does, so give this a more generous safety window — a
    // pathological branching-factor position at depth 5+ can genuinely
    // take a few seconds, and we'd rather wait than falsely time out.
    return this._enqueue(fen, `go depth ${depth}`, 15000);
  }

  _enqueue(fen, goCommand, timeoutMs) {
    // Chain this request onto the queue. `.catch(() => {})` on the queue
    // itself stops one failed request from poisoning the chain for every
    // request queued after it — each caller still sees its own real
    // resolve/reject via the returned promise below.
    const run = () => this._runAnalyze(fen, goCommand, timeoutMs);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  _runAnalyze(fen, goCommand, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.process) {
        reject(new Error('Engine not started — call start() first.'));
        return;
      }

      let buffer = '';
      let lastInfo = { scoreCp: 0, depth: 0, nodes: 0 };
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.process.stdout.off('data', onData);
        reject(new Error(`Engine did not respond within ${timeoutMs}ms.`));
      }, timeoutMs);

      const onData = (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (line.startsWith('info')) {
            lastInfo = parseInfoLine(line);
          } else if (line.startsWith('bestmove')) {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            this.process.stdout.off('data', onData);
            const bestMove = line.split(' ')[1];

            // UCI reports "score cp" relative to whoever is to move in
            // the position we just sent — standard for the protocol, but
            // inconvenient for us: every caller in this app (the eval
            // gauge, the game-analysis eval graph, move classification)
            // wants a single consistent White-perspective number so
            // positions can be compared across a whole game regardless
            // of whose turn it was. Convert once, here, so nobody else
            // has to remember to.
            const sideToMove = fen.split(' ')[1]; // 'w' or 'b'
            const whiteScoreCp = sideToMove === 'b' ? -lastInfo.scoreCp : lastInfo.scoreCp;

            resolve({ bestMove, ...lastInfo, scoreCp: whiteScoreCp });
            return;
          }
        }
      };

      this.process.stdout.on('data', onData);
      this.process.stdin.write(`position fen ${fen}\n`);
      this.process.stdin.write(`${goCommand}\n`);
    });
  }
}

// Parses a line like: "info depth 5 score cp 90 nodes 12345"
function parseInfoLine(line) {
  const depthMatch = line.match(/depth (-?\d+)/);
  const scoreMatch = line.match(/score cp (-?\d+)/);
  const nodesMatch = line.match(/nodes (-?\d+)/);

  return {
    depth: depthMatch ? parseInt(depthMatch[1], 10) : 0,
    scoreCp: scoreMatch ? parseInt(scoreMatch[1], 10) : 0,
    nodes: nodesMatch ? parseInt(nodesMatch[1], 10) : 0,
  };
}

module.exports = { UciEngine };
