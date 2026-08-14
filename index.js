// index.js
//
// Demo: analyze a position with the engine, then ask the coach to explain it.
// Usage: GROQ_API_KEY=your_key_here node index.js

const { UciEngine } = require('./engine.js');
const { explainPosition } = require('./coach.js');

const ENGINE_PATH = process.platform === 'win32' ? './kestrel.exe' : './kestrel';

async function main() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error('Missing GROQ_API_KEY environment variable.');
    console.error('Get a free key at https://console.groq.com, then run:');
    console.error('  GROQ_API_KEY=your_key_here node index.js   (Mac/Linux)');
    console.error('  $env:GROQ_API_KEY="your_key_here"; node index.js   (PowerShell)');
    process.exit(1);
  }

  // A position with a clear tactical idea, good for demoing the coach:
  // white queen can capture an undefended black rook.
  const fen = '4k3/8/8/3r4/8/8/8/3QK3 w - - 0 1';

  const engine = new UciEngine(ENGINE_PATH);
  engine.start();

  try {
    console.log('Analyzing position...');
    const analysis = await engine.analyze(fen, 1000);
    console.log('Engine says:', analysis);

    console.log('\nAsking the coach to explain...');
    const explanation = await explainPosition({ ...analysis, fen, apiKey });
    console.log('\n--- Coach explanation ---');
    console.log(explanation);
  } finally {
    // Always shut the engine process down cleanly, even if the coach call
    // fails — leaving the child process's pipes open when the script exits
    // is what caused the libuv "UV_HANDLE_CLOSING" crash on Windows.
    engine.stop();
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
