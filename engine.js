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
   *
   * @param {string} fen
   * @param {number} movetimeMs - how long the engine should think
   * @returns {Promise<{bestMove: string, scoreCp: number, depth: number, nodes: number}>}
   */
  analyze(fen, movetimeMs = 1000) {
    return new Promise((resolve, reject) => {
      if (!this.process) {
        reject(new Error('Engine not started — call start() first.'));
        return;
      }

      let buffer = '';
      let lastInfo = { scoreCp: 0, depth: 0, nodes: 0 };

      const onData = (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep any incomplete trailing line for next chunk

        for (const rawLine of lines) {
          const line = rawLine.trim(); // strips the trailing \r Windows adds after \n splits
          if (line.startsWith('info')) {
            lastInfo = parseInfoLine(line);
          } else if (line.startsWith('bestmove')) {
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
