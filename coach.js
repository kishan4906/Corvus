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
 * @param {number} analysis.scoreCp - centipawn eval, from side-to-move's perspective
 * @param {string} fen - the position being explained
 * @param {string} apiKey - Groq API key (from console.groq.com)
 * @returns {Promise<string>} plain-English explanation
 */
async function explainPosition({ bestMove, scoreCp, fen, apiKey }) {
  const sideToMove = fen.split(' ')[1] === 'w' ? 'White' : 'Black';
  const evalPawns = (scoreCp / 100).toFixed(2);

  const prompt = buildPrompt({ fen, sideToMove, bestMove, evalPawns });

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
            'without saying why. Reference actual squares and pieces.',
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

function buildPrompt({ fen, sideToMove, bestMove, evalPawns }) {
  return [
    `Position (FEN): ${fen}`,
    `Side to move: ${sideToMove}`,
    `Engine's recommended move (UCI notation, e.g. e2e4 means the piece on e2 moves to e4): ${bestMove}`,
    `Engine evaluation: ${evalPawns} (positive favors White, negative favors Black, in units of pawns)`,
    '',
    'Explain why this is a strong move in this position, and briefly what the evaluation number means for whoever is winning.',
  ].join('\n');
}

module.exports = { explainPosition };
