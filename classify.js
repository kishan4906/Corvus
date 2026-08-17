// classify.js
//
// Turns a pair of consecutive White-perspective evals into a move
// classification (Best/Good/Inaccuracy/Mistake/Blunder), plus a simple
// game-wide accuracy percentage.
//
// Classification is based on WIN PROBABILITY loss, not raw centipawn
// loss — this matters a lot. A 30cp swing near an equal position (0cp)
// represents a real, meaningful shift in who's likely to win. The same
// 30cp swing when someone's already up a queen (+900cp) is essentially
// noise — both positions are just "winning". Flat centipawn bands treat
// these the same everywhere on the eval scale, which is wrong: it makes
// a genuinely winning endgame look like every move is equally perfect
// (nothing changes the outcome much either way), while under-penalizing
// real mistakes made in balanced positions (where the same raw cp swing
// matters far more). Win probability, via a standard sigmoid, naturally
// captures this — it's flat where being "more winning" doesn't matter,
// and steep near equal, where it does.

// Search reports forced-mate positions with an intentionally huge score
// (so the engine always prefers a mate over any material gain). That's
// correct internally, but a raw ~10^9 number would wreck the eval graph's
// scale and win-probability math. Clamp anything beyond a realistic
// non-mate eval down to a fixed "decisive advantage" ceiling.
const MATE_SCORE_CAP = 10000; // 100 pawns — no real (non-mate) position gets close to this

function normalizeScore(scoreCp) {
  return Math.max(-MATE_SCORE_CAP, Math.min(MATE_SCORE_CAP, scoreCp));
}

// Converts a centipawn eval (from whichever perspective the caller wants
// "win probability" measured in) into an approximate win percentage,
// 0-100. This is the same standard logistic-curve approximation widely
// used for this purpose (not a claim to reproduce any specific site's
// exact proprietary constant) — cp=0 -> 50%, and it saturates toward 0
// or 100 as the advantage grows decisive.
function winProbability(cp) {
  return 100 / (1 + Math.pow(10, -cp / 400));
}

// Win-probability-point-loss bands. Deliberately much smaller numbers
// than the old centipawn bands were, since win% loss is naturally a
// small-magnitude quantity (0-100 scale, and most moves lose only a
// couple of points even when imperfect) — these are round, explainable
// defaults, not a claim to match any specific site's exact thresholds.
const THRESHOLDS = [
  { max: 2, label: 'Best' },
  { max: 5, label: 'Good' },
  { max: 10, label: 'Inaccuracy' },
  { max: 20, label: 'Mistake' },
  { max: Infinity, label: 'Blunder' },
];

/**
 * @param {number} evalBeforeWhitePov - White-perspective eval before the move
 * @param {number} evalAfterWhitePov - White-perspective eval after the move
 * @param {'w'|'b'} mover - who made the move
 * @returns {{ label: string, centipawnLoss: number, winProbLoss: number }}
 *   centipawnLoss is kept for display (e.g. "lost 0.90 pawns") — the
 *   CLASSIFICATION decision itself is made on winProbLoss.
 */
function classifyMove(evalBeforeWhitePov, evalAfterWhitePov, mover) {
  const swing = evalAfterWhitePov - evalBeforeWhitePov;
  const centipawnLoss = Math.max(0, mover === 'w' ? -swing : swing);

  // Win probability from the MOVER's own perspective, before and after —
  // flip the White-POV eval when Black is the mover, so "higher is
  // better for whoever just moved" holds either way.
  const moverEvalBefore = mover === 'w' ? evalBeforeWhitePov : -evalBeforeWhitePov;
  const moverEvalAfter = mover === 'w' ? evalAfterWhitePov : -evalAfterWhitePov;
  const winProbLoss = Math.max(0, winProbability(moverEvalBefore) - winProbability(moverEvalAfter));

  const match = THRESHOLDS.find((t) => winProbLoss <= t.max);
  return { label: match.label, centipawnLoss, winProbLoss };
}

/**
 * Rough per-game accuracy: 100% minus a penalty scaled by average
 * win-probability-point loss, floored near 0. Not a statistically
 * calibrated model — a simple, monotonic, explainable stand-in.
 *
 * @param {number[]} winProbLosses - one per move for the player being scored
 * @returns {number} accuracy percentage, 0-100
 */
function computeAccuracy(winProbLosses) {
  if (winProbLosses.length === 0) return 100;
  const avgLoss = winProbLosses.reduce((a, b) => a + b, 0) / winProbLosses.length;
  // avgLoss of 0 -> 100%, avgLoss of ~8 win-probability points or more ->
  // approaches 0%. Diminishing-returns curve so a single blunder doesn't
  // crater the score as hard as several medium mistakes would.
  const accuracy = 100 * Math.exp(-avgLoss / 8);
  return Math.round(accuracy * 10) / 10;
}

module.exports = { classifyMove, computeAccuracy, normalizeScore, winProbability, THRESHOLDS };
