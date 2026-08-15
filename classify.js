// classify.js
//
// Turns a pair of consecutive White-perspective evals into a move
// classification (Best/Good/Inaccuracy/Mistake/Blunder), plus a simple
// game-wide accuracy percentage. Thresholds are simplified, round
// centipawn-loss bands — not a claim to match any specific site's exact
// formula, just a reasonable, explainable approximation.

// Search reports forced-mate positions with an intentionally huge score
// (so the engine always prefers a mate over any material gain). That's
// correct internally, but a raw ~10^9 number would wreck the eval graph's
// scale, blow up centipawn-loss math, and look like garbage in the UI.
// Clamp anything beyond a realistic non-mate eval down to a fixed
// "decisive advantage" ceiling — still huge enough to always classify as
// a Blunder/Best correctly, just no longer astronomically large.
const MATE_SCORE_CAP = 10000; // 100 pawns — no real (non-mate) position gets close to this

function normalizeScore(scoreCp) {
  return Math.max(-MATE_SCORE_CAP, Math.min(MATE_SCORE_CAP, scoreCp));
}

const THRESHOLDS = [
  { max: 10, label: 'Best' },
  { max: 25, label: 'Good' },
  { max: 50, label: 'Inaccuracy' },
  { max: 100, label: 'Mistake' },
  { max: Infinity, label: 'Blunder' },
];

/**
 * @param {number} evalBeforeWhitePov - White-perspective eval before the move
 * @param {number} evalAfterWhitePov - White-perspective eval after the move
 * @param {'w'|'b'} mover - who made the move
 * @returns {{ label: string, centipawnLoss: number }}
 */
function classifyMove(evalBeforeWhitePov, evalAfterWhitePov, mover) {
  const swing = evalAfterWhitePov - evalBeforeWhitePov;
  // White wants the White-POV eval to go up (or at least not drop);
  // Black wants it to go down. Either way, "loss" is how much the move
  // moved the eval in the direction that HURTS the mover.
  const centipawnLoss = Math.max(0, mover === 'w' ? -swing : swing);

  const match = THRESHOLDS.find((t) => centipawnLoss <= t.max);
  return { label: match.label, centipawnLoss };
}

/**
 * Rough per-game accuracy: 100% minus a penalty scaled by average
 * centipawn loss, floored at 0. Not a statistically calibrated model —
 * a simple, monotonic, explainable stand-in.
 *
 * @param {number[]} centipawnLosses - one per move for the player being scored
 * @returns {number} accuracy percentage, 0-100
 */
function computeAccuracy(centipawnLosses) {
  if (centipawnLosses.length === 0) return 100;
  const avgLoss = centipawnLosses.reduce((a, b) => a + b, 0) / centipawnLosses.length;
  // avgLoss of 0 -> 100%, avgLoss of ~150cp or more -> approaches 0%.
  // Diminishing-returns curve so a single blunder doesn't crater the score
  // as hard as several medium mistakes would.
  const accuracy = 100 * Math.exp(-avgLoss / 120);
  return Math.round(accuracy * 10) / 10;
}

module.exports = { classifyMove, computeAccuracy, normalizeScore, THRESHOLDS };
