// server.js
//
// HTTP API in front of the existing engine + coach logic (engine.js,
// coach.js). This is what the React frontend talks to — it never touches
// the engine process or the Groq API directly.

const express = require('express');
const cors = require('cors');
const { UciEngine } = require('./engine.js');
const { explainPosition } = require('./coach.js');

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
// Body: { fen: string, movetimeMs?: number, explain?: boolean }
// Returns: { bestMove, scoreCp, depth, nodes, explanation? }
app.post('/api/analyze', async (req, res) => {
  const { fen, movetimeMs = 800, explain = true } = req.body;

  if (!fen || typeof fen !== 'string') {
    res.status(400).json({ error: 'Request body must include a "fen" string.' });
    return;
  }

  try {
    const analysis = await engine.analyze(fen, movetimeMs);
    const result = { ...analysis };

    if (explain) {
      if (!GROQ_API_KEY) {
        result.explanation = null;
        result.explanationError = 'GROQ_API_KEY not set on the server — analysis only, no explanation.';
      } else {
        result.explanation = await explainPosition({ ...analysis, fen, apiKey: GROQ_API_KEY });
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
