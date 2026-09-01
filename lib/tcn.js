// Decoder for chess.com's TCN move encoding (2 chars per move).
// Char index 0-63 maps to a board square (a1=0, b1=1, ... h8=63).
// A second char above 63 encodes a pawn promotion (piece + file offset).
const TABLE =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?{~}(^)[_]@#$,./&-*++=";
const PROMO_PIECES = "qnrbkp";

function idxToSquare(i) {
  return { file: i % 8, rank: Math.floor(i / 8) };
}

export function squareName({ file, rank }) {
  return "abcdefgh"[file] + (rank + 1);
}

// Returns [{from:{file,rank}, to:{file,rank}, promotion?}]
export function decodeTCN(tcn) {
  const moves = [];
  for (let i = 0; i + 1 < tcn.length; i += 2) {
    const o1 = TABLE.indexOf(tcn[i]);
    const o2 = TABLE.indexOf(tcn[i + 1]);
    if (o1 < 0 || o2 < 0) break;
    const move = {};
    if (o1 <= 63) move.from = idxToSquare(o1);
    else continue; // piece drop (crazyhouse) — not handled
    if (o2 > 63) {
      move.promotion = PROMO_PIECES[Math.floor((o2 - 64) / 3)];
      const df = ((o2 - 64) % 3) - 1;
      const toRank = move.from.rank === 6 ? 7 : 0;
      move.to = { file: move.from.file + df, rank: toRank };
    } else {
      move.to = idxToSquare(o2);
    }
    moves.push(move);
  }
  return moves;
}
