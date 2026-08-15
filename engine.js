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
   */
  analyze(fen, movetimeMs = 1000) {
    // Chain this request onto the queue. `.catch(() => {})` on the queue
    // itself stops one failed request from poisoning the chain for every
    // request queued after it — each caller still sees its own real
    // resolve/reject via the returned promise below.
    const run = () => this._runAnalyze(fen, movetimeMs);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  _runAnalyze(fen, movetimeMs) {
    return new Promise((resolve, reject) => {
      if (!this.process) {
        reject(new Error('Engine not started — call start() first.'));
        return;
      }

      let buffer = '';
      let lastInfo = { scoreCp: 0, depth: 0, nodes: 0 };
      let settled = false;

      // Safety net: even a well-behaved engine call should never take
      // dramatically longer than its own think budget. If it does — a
      // hung process, a malformed FEN the engine chokes on, whatever —
      // fail loudly instead of hanging the request (and the queue behind
      // it) forever.
      const timeoutMs = movetimeMs + 5000;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.process.stdout.off('data', onData);
        reject(new Error(`Engine did not respond within ${timeoutMs}ms.`));
      }, timeoutMs);

      const onData = (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep any incomplete trailing line for next chunk

        for (const rawLine of lines) {
          const line = rawLine.trim(); // strips the trailing \r Windows adds after \n splits
          if (line.startsWith('info')) {
            lastInfo = parseInfoLine(line);
          } else if (line.startsWith('bestmove')) {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            this.process.stdout.off('data', onData);
            const bestMove = line.split(' ')[1];
            resolve({ bestMove, ...lastInfo });
            return;
          }
        }
      };

      this.process.stdout.on('data', onData);
      this.process.stdin.write(`position fen ${fen}\n`);
      this.process.stdin.write(`go movetime ${movetimeMs}\n`);
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