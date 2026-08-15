// openings.js
//
// A small curated table of common opening names, matched by SAN move
// prefix. This is NOT a full ECO database — it's a "good enough for a
// demo" set of well-known openings, roughly 40 entries covering what
// club-level games actually reach. Unrecognized openings just report
// as "Unrecognized opening" rather than guessing.

const OPENINGS = [
  { name: 'Ruy Lopez', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'] },
  { name: 'Italian Game', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'] },
  { name: 'Scotch Game', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'd4'] },
  { name: "Petrov's Defense", moves: ['e4', 'e5', 'Nf3', 'Nf6'] },
  { name: 'Philidor Defense', moves: ['e4', 'e5', 'Nf3', 'd6'] },
  { name: "King's Gambit", moves: ['e4', 'e5', 'f4'] },
  { name: 'Vienna Game', moves: ['e4', 'e5', 'Nc3'] },
  { name: 'Sicilian Defense, Najdorf', moves: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6'] },
  { name: 'Sicilian Defense, Dragon', moves: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'g6'] },
  { name: 'Sicilian Defense, Open', moves: ['e4', 'c5', 'Nf3'] },
  { name: 'Sicilian Defense', moves: ['e4', 'c5'] },
  { name: 'French Defense', moves: ['e4', 'e6'] },
  { name: 'Caro-Kann Defense', moves: ['e4', 'c6'] },
  { name: 'Pirc Defense', moves: ['e4', 'd6'] },
  { name: 'Scandinavian Defense', moves: ['e4', 'd5'] },
  { name: 'Alekhine Defense', moves: ['e4', 'Nf6'] },
  { name: "Queen's Gambit Declined", moves: ['d4', 'd5', 'c4', 'e6'] },
  { name: "Queen's Gambit Accepted", moves: ['d4', 'd5', 'c4', 'dxc4'] },
  { name: 'Slav Defense', moves: ['d4', 'd5', 'c4', 'c6'] },
  { name: "Queen's Gambit", moves: ['d4', 'd5', 'c4'] },
  { name: "King's Indian Defense", moves: ['d4', 'Nf6', 'c4', 'g6'] },
  { name: 'Nimzo-Indian Defense', moves: ['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4'] },
  { name: 'Grünfeld Defense', moves: ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'd5'] },
  { name: 'Bogo-Indian Defense', moves: ['d4', 'Nf6', 'c4', 'e6', 'Nf3', 'Bb4'] },
  { name: "Queen's Indian Defense", moves: ['d4', 'Nf6', 'c4', 'e6', 'Nf3', 'b6'] },
  { name: 'Dutch Defense', moves: ['d4', 'f5'] },
  { name: 'Benoni Defense', moves: ['d4', 'Nf6', 'c4', 'c5'] },
  { name: 'London System', moves: ['d4', 'd5', 'Nf3', 'Nf6', 'Bf4'] },
  { name: "Queen's Pawn Game", moves: ['d4', 'd5'] },
  { name: 'English Opening', moves: ['c4'] },
  { name: 'Reti Opening', moves: ['Nf3', 'd5', 'c4'] },
  { name: "King's Indian Attack", moves: ['Nf3', 'd5', 'g3'] },
  { name: "Bird's Opening", moves: ['f4'] },
  { name: 'Van Geet Opening', moves: ['Nc3'] },
];

/**
 * @param {string[]} sanMoves - the game's moves in SAN, in order
 * @returns {string} the longest-matching opening name, or a generic fallback
 */
function identifyOpening(sanMoves) {
  let best = null;
  let bestLength = 0;

  for (const opening of OPENINGS) {
    const len = opening.moves.length;
    if (sanMoves.length < len) continue;

    const matches = opening.moves.every((move, i) => sanMoves[i] === move);
    if (matches && len > bestLength) {
      best = opening.name;
      bestLength = len;
    }
  }

  return best || 'Unrecognized opening';
}

module.exports = { identifyOpening };
