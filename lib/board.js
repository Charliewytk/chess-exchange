// Minimal board-state tracker: applies from/to moves (as decoded from TCN)
// and produces FEN piece placement. Not a rules engine — the moves we apply
// come from real games, so they are already legal. We only need to recognize
// castling, en passant and promotion to keep the position correct.
import { squareName } from "./tcn.js";

const START = [
  "R", "N", "B", "Q", "K", "B", "N", "R",
  "P", "P", "P", "P", "P", "P", "P", "P",
  null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null,
  "p", "p", "p", "p", "p", "p", "p", "p",
  "r", "n", "b", "q", "k", "b", "n", "r",
];

const VALUES = { p: 1, n: 3, b: 3.15, r: 5, q: 9, k: 0 };

export class Board {
  constructor() {
    this.squares = START.slice();
    this.ply = 0; // 0 = white to move
  }

  static idx({ file, rank }) {
    return rank * 8 + file;
  }

  // Apply a decoded move; returns a short human-readable label like "Nf3" / "exd5" / "O-O".
  apply(move) {
    const fromIdx = Board.idx(move.from);
    const toIdx = Board.idx(move.to);
    const piece = this.squares[fromIdx];
    if (!piece) {
      this.ply++;
      return "?";
    }
    const lower = piece.toLowerCase();
    const isWhite = piece === piece.toUpperCase();
    let label;

    // Castling: king moving two or more files, or onto its own rook.
    const target = this.squares[toIdx];
    const ownRook = target && target.toLowerCase() === "r" &&
      (target === target.toUpperCase()) === isWhite;
    if (lower === "k" && (Math.abs(move.to.file - move.from.file) >= 2 || ownRook)) {
      const kingSide = move.to.file > move.from.file;
      const rank = move.from.rank;
      const rookFrom = this.findRook(rank, kingSide, isWhite, move.from.file);
      const kingTo = Board.idx({ file: kingSide ? 6 : 2, rank });
      const rookTo = Board.idx({ file: kingSide ? 5 : 3, rank });
      this.squares[fromIdx] = null;
      if (rookFrom != null) this.squares[rookFrom] = null;
      this.squares[kingTo] = piece;
      if (rookFrom != null) this.squares[rookTo] = isWhite ? "R" : "r";
      label = kingSide ? "O-O" : "O-O-O";
      this.ply++;
      return label;
    }

    const capture = !!target;
    // En passant: pawn moves diagonally onto an empty square.
    if (lower === "p" && move.from.file !== move.to.file && !target) {
      const capIdx = Board.idx({ file: move.to.file, rank: move.from.rank });
      this.squares[capIdx] = null;
    }

    this.squares[fromIdx] = null;
    let placed = piece;
    if (move.promotion) {
      placed = isWhite ? move.promotion.toUpperCase() : move.promotion.toLowerCase();
    }
    this.squares[toIdx] = placed;

    const dest = squareName(move.to);
    if (lower === "p") {
      label = (capture || move.from.file !== move.to.file)
        ? "abcdefgh"[move.from.file] + "x" + dest
        : dest;
      if (move.promotion) label += "=" + move.promotion.toUpperCase();
    } else {
      label = piece.toUpperCase() + (capture ? "x" : "") + dest;
    }
    this.ply++;
    return label;
  }

  findRook(rank, kingSide, isWhite, kingFile) {
    const rook = isWhite ? "R" : "r";
    const files = kingSide ? [7, 6, 5] : [0, 1, 2, 3];
    for (const f of files) {
      if (f === kingFile) continue;
      const i = Board.idx({ file: f, rank });
      if (this.squares[i] === rook) return i;
    }
    return null;
  }

  fen() {
    let out = "";
    for (let rank = 7; rank >= 0; rank--) {
      let empty = 0;
      for (let file = 0; file < 8; file++) {
        const p = this.squares[rank * 8 + file];
        if (!p) empty++;
        else {
          if (empty) { out += empty; empty = 0; }
          out += p;
        }
      }
      if (empty) out += empty;
      if (rank) out += "/";
    }
    out += this.ply % 2 === 0 ? " w" : " b";
    out += " - - 0 " + (Math.floor(this.ply / 2) + 1);
    return out;
  }

  // Material balance from white's point of view, in pawns.
  materialDiff() {
    let diff = 0;
    for (const p of this.squares) {
      if (!p) continue;
      const v = VALUES[p.toLowerCase()] ?? 0;
      diff += p === p.toUpperCase() ? v : -v;
    }
    return diff;
  }
}
