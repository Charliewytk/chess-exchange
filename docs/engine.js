// Compact legal-move alpha-beta engine. Given a FEN it returns White/Draw/Black
// probabilities (WDL), so the market prior can follow the position instead of
// ratings alone. Elo remains the fallback when there is no board to evaluate.

const FILE = (sq) => sq & 7;
const RANK = (sq) => sq >> 3;
const SQ = (f, r) => r * 8 + f;
const ON = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;
const isWhite = (p) => p === p.toUpperCase();

const N_DELTA = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const K_DELTA = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const B_DIR = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const R_DIR = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const Q_DIR = [...B_DIR, ...R_DIR];

const VAL = { P: 100, N: 320, B: 330, R: 500, Q: 900, K: 0 };
const MATE = 100000;
const MAX_NODES = 18000;
const DEFAULT_DEPTH = 3;

// Piece-square tables, white's view (rank 0 = white's back rank). Black mirrors.
const PST = {
  P: [
     0,  0,  0,  0,  0,  0,  0,  0,
     5, 10, 10,-20,-20, 10, 10,  5,
     5, -5,-10,  0,  0,-10, -5,  5,
     0,  0,  0, 20, 20,  0,  0,  0,
     5,  5, 10, 25, 25, 10,  5,  5,
    10, 10, 20, 30, 30, 20, 10, 10,
    50, 50, 50, 50, 50, 50, 50, 50,
     0,  0,  0,  0,  0,  0,  0,  0,
  ],
  N: [
    -50,-40,-30,-30,-30,-30,-40,-50,
    -40,-20,  0,  5,  5,  0,-20,-40,
    -30,  5, 10, 15, 15, 10,  5,-30,
    -30,  0, 15, 20, 20, 15,  0,-30,
    -30,  5, 15, 20, 20, 15,  5,-30,
    -30,  0, 10, 15, 15, 10,  0,-30,
    -40,-20,  0,  0,  0,  0,-20,-40,
    -50,-40,-30,-30,-30,-30,-40,-50,
  ],
  B: [
    -20,-10,-10,-10,-10,-10,-10,-20,
    -10,  5,  0,  0,  0,  0,  5,-10,
    -10, 10, 10, 10, 10, 10, 10,-10,
    -10,  0, 10, 10, 10, 10,  0,-10,
    -10,  5,  5, 10, 10,  5,  5,-10,
    -10,  0,  5, 10, 10,  5,  0,-10,
    -10,  5,  0,  0,  0,  0,  5,-10,
    -20,-10,-10,-10,-10,-10,-10,-20,
  ],
  R: [
     0,  0,  5, 10, 10,  5,  0,  0,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
     5, 10, 10, 10, 10, 10, 10,  5,
     0,  0,  0,  0,  0,  0,  0,  0,
  ],
  Q: [
    -20,-10,-10, -5, -5,-10,-10,-20,
    -10,  0,  5,  0,  0,  0,  0,-10,
    -10,  5,  5,  5,  5,  5,  0,-10,
      0,  0,  5,  5,  5,  5,  0, -5,
     -5,  0,  5,  5,  5,  5,  0, -5,
    -10,  0,  5,  5,  5,  5,  0,-10,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -20,-10,-10, -5, -5,-10,-10,-20,
  ],
  K: [
     20, 30, 10,  0,  0, 10, 30, 20,
     20, 20,  0,  0,  0,  0, 20, 20,
    -10,-20,-20,-20,-20,-20,-20,-10,
    -20,-30,-30,-40,-40,-30,-30,-20,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
  ],
};

const cache = new Map();

export function parseFen(fen) {
  if (!fen || typeof fen !== "string") return null;
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const rows = parts[0].split("/");
  if (rows.length !== 8) return null;
  const sq = new Array(64).fill(null);
  let wk = -1, bk = -1;
  for (let r = 7, i = 0; r >= 0; r--, i++) {
    let f = 0;
    for (const ch of rows[i]) {
      if (ch >= "1" && ch <= "8") {
        f += Number(ch);
      } else if ("PNBRQKpnbrqk".includes(ch)) {
        if (f > 7) return null;
        const s = SQ(f, r);
        sq[s] = ch;
        if (ch === "K") wk = s;
        if (ch === "k") bk = s;
        f++;
      } else {
        return null;
      }
    }
    if (f !== 8) return null;
  }
  if (wk < 0 || bk < 0) return null;

  let castle = 0;
  if (parts[2] && parts[2] !== "-") {
    if (parts[2].includes("K")) castle |= 1;
    if (parts[2].includes("Q")) castle |= 2;
    if (parts[2].includes("k")) castle |= 4;
    if (parts[2].includes("q")) castle |= 8;
  }
  let ep = -1;
  if (parts[3] && parts[3] !== "-") {
    const f = parts[3].charCodeAt(0) - 97;
    const r = Number(parts[3][1]) - 1;
    if (ON(f, r)) ep = SQ(f, r);
  }
  return { sq, wtm: parts[1] === "w", castle, ep, wk, bk };
}

function attacked(pos, target, byWhite) {
  const { sq } = pos;
  const pawn = byWhite ? "P" : "p";
  const pr = byWhite ? -1 : 1;
  for (const df of [-1, 1]) {
    const f = FILE(target) + df, r = RANK(target) + pr;
    if (ON(f, r) && sq[SQ(f, r)] === pawn) return true;
  }
  const knight = byWhite ? "N" : "n";
  for (const [df, dr] of N_DELTA) {
    const f = FILE(target) + df, r = RANK(target) + dr;
    if (ON(f, r) && sq[SQ(f, r)] === knight) return true;
  }
  const king = byWhite ? "K" : "k";
  for (const [df, dr] of K_DELTA) {
    const f = FILE(target) + df, r = RANK(target) + dr;
    if (ON(f, r) && sq[SQ(f, r)] === king) return true;
  }
  if (slideHits(pos, target, B_DIR, byWhite ? ["B", "Q"] : ["b", "q"])) return true;
  if (slideHits(pos, target, R_DIR, byWhite ? ["R", "Q"] : ["r", "q"])) return true;
  return false;
}

function slideHits(pos, target, dirs, pieces) {
  for (const [df, dr] of dirs) {
    let f = FILE(target) + df, r = RANK(target) + dr;
    while (ON(f, r)) {
      const p = pos.sq[SQ(f, r)];
      if (p) return pieces.includes(p);
      f += df;
      r += dr;
    }
  }
  return false;
}

function genStep(pos, s, p, deltas, moves) {
  const mine = isWhite(p);
  for (const [df, dr] of deltas) {
    const f = FILE(s) + df, r = RANK(s) + dr;
    if (!ON(f, r)) continue;
    const t = SQ(f, r);
    const cap = pos.sq[t];
    if (!cap || isWhite(cap) !== mine) moves.push({ from: s, to: t });
  }
}

function genSlide(pos, s, p, dirs, moves) {
  const mine = isWhite(p);
  for (const [df, dr] of dirs) {
    let f = FILE(s) + df, r = RANK(s) + dr;
    while (ON(f, r)) {
      const t = SQ(f, r);
      const cap = pos.sq[t];
      if (!cap) {
        moves.push({ from: s, to: t });
      } else {
        if (isWhite(cap) !== mine) moves.push({ from: s, to: t });
        break;
      }
      f += df;
      r += dr;
    }
  }
}

function pushPawn(moves, from, to, lastRank, meWhite) {
  if (RANK(to) === lastRank) {
    for (const promo of (meWhite ? ["Q", "R", "B", "N"] : ["q", "r", "b", "n"])) {
      moves.push({ from, to, promo });
    }
  } else {
    moves.push({ from, to });
  }
}

function genPawn(pos, s, p, moves) {
  const meWhite = p === "P";
  const dir = meWhite ? 8 : -8;
  const startRank = meWhite ? 1 : 6;
  const lastRank = meWhite ? 7 : 0;
  const f = FILE(s), r = RANK(s);
  const t1 = s + dir;
  if (ON(f, r + (meWhite ? 1 : -1)) && !pos.sq[t1]) {
    pushPawn(moves, s, t1, lastRank, meWhite);
    const t2 = s + 2 * dir;
    if (r === startRank && !pos.sq[t2]) moves.push({ from: s, to: t2 });
  }
  for (const df of [-1, 1]) {
    if (!ON(f + df, r + (meWhite ? 1 : -1))) continue;
    const t = s + dir + df;
    const cap = pos.sq[t];
    if (cap && isWhite(cap) !== meWhite) pushPawn(moves, s, t, lastRank, meWhite);
    else if (t === pos.ep) moves.push({ from: s, to: t, ep: true });
  }
}

function genCastle(pos, moves) {
  if (pos.wtm) {
    if ((pos.castle & 1) && !pos.sq[5] && !pos.sq[6]
        && !attacked(pos, 4, false) && !attacked(pos, 5, false) && !attacked(pos, 6, false)) {
      moves.push({ from: 4, to: 6, castle: "K" });
    }
    if ((pos.castle & 2) && !pos.sq[1] && !pos.sq[2] && !pos.sq[3]
        && !attacked(pos, 4, false) && !attacked(pos, 3, false) && !attacked(pos, 2, false)) {
      moves.push({ from: 4, to: 2, castle: "Q" });
    }
  } else {
    if ((pos.castle & 4) && !pos.sq[61] && !pos.sq[62]
        && !attacked(pos, 60, true) && !attacked(pos, 61, true) && !attacked(pos, 62, true)) {
      moves.push({ from: 60, to: 62, castle: "k" });
    }
    if ((pos.castle & 8) && !pos.sq[57] && !pos.sq[58] && !pos.sq[59]
        && !attacked(pos, 60, true) && !attacked(pos, 59, true) && !attacked(pos, 58, true)) {
      moves.push({ from: 60, to: 58, castle: "q" });
    }
  }
}

function genMoves(pos) {
  const moves = [];
  const meWhite = pos.wtm;
  for (let s = 0; s < 64; s++) {
    const p = pos.sq[s];
    if (!p || isWhite(p) !== meWhite) continue;
    const kind = p.toUpperCase();
    if (kind === "P") genPawn(pos, s, p, moves);
    else if (kind === "N") genStep(pos, s, p, N_DELTA, moves);
    else if (kind === "K") genStep(pos, s, p, K_DELTA, moves);
    else if (kind === "B") genSlide(pos, s, p, B_DIR, moves);
    else if (kind === "R") genSlide(pos, s, p, R_DIR, moves);
    else if (kind === "Q") genSlide(pos, s, p, Q_DIR, moves);
  }
  genCastle(pos, moves);
  return moves;
}

function apply(pos, m) {
  const next = {
    sq: pos.sq.slice(),
    wtm: !pos.wtm,
    castle: pos.castle,
    ep: -1,
    wk: pos.wk,
    bk: pos.bk,
  };
  const piece = next.sq[m.from];
  next.sq[m.from] = null;
  if (m.ep) next.sq[pos.wtm ? m.to - 8 : m.to + 8] = null;
  next.sq[m.to] = m.promo || piece;
  if (piece === "K") {
    next.wk = m.to;
    next.castle &= ~3;
    if (m.castle === "K") { next.sq[7] = null; next.sq[5] = "R"; }
    if (m.castle === "Q") { next.sq[0] = null; next.sq[3] = "R"; }
  } else if (piece === "k") {
    next.bk = m.to;
    next.castle &= ~12;
    if (m.castle === "k") { next.sq[63] = null; next.sq[61] = "r"; }
    if (m.castle === "q") { next.sq[56] = null; next.sq[59] = "r"; }
  }
  if (m.from === 0 || m.to === 0) next.castle &= ~2;
  if (m.from === 7 || m.to === 7) next.castle &= ~1;
  if (m.from === 56 || m.to === 56) next.castle &= ~8;
  if (m.from === 63 || m.to === 63) next.castle &= ~4;
  if (piece === "P" && m.to - m.from === 16) next.ep = m.from + 8;
  if (piece === "p" && m.from - m.to === 16) next.ep = m.from - 8;
  return next;
}

function legalMoves(pos) {
  const out = [];
  for (const m of genMoves(pos)) {
    const next = apply(pos, m);
    const king = pos.wtm ? next.wk : next.bk;
    if (!attacked(next, king, !pos.wtm)) out.push(m);
  }
  return out;
}

export function insufficientMaterial(pos) {
  const extras = [];
  for (let i = 0; i < 64; i++) {
    const p = pos.sq[i];
    if (p && p.toUpperCase() !== "K") extras.push({ p, i });
  }
  if (!extras.length) return true;
  if (extras.length === 1) {
    const k = extras[0].p.toUpperCase();
    return k === "N" || k === "B";
  }
  if (extras.length === 2
      && extras[0].p.toUpperCase() === "B"
      && extras[1].p.toUpperCase() === "B") {
    const c0 = (FILE(extras[0].i) + RANK(extras[0].i)) & 1;
    const c1 = (FILE(extras[1].i) + RANK(extras[1].i)) & 1;
    return c0 === c1;
  }
  return false;
}

function pstBonus(p, sq) {
  const table = PST[p.toUpperCase()];
  if (!table) return 0;
  const idx = isWhite(p) ? sq : SQ(FILE(sq), 7 - RANK(sq));
  return table[idx] || 0;
}

function remainingMaterial(pos) {
  let mat = 0;
  for (const p of pos.sq) {
    if (!p) continue;
    mat += VAL[p.toUpperCase()] || 0;
  }
  return mat;
}

function evaluate(pos) {
  if (insufficientMaterial(pos)) return 0;
  let score = 0;
  for (let i = 0; i < 64; i++) {
    const p = pos.sq[i];
    if (!p) continue;
    const s = isWhite(p) ? 1 : -1;
    score += s * ((VAL[p.toUpperCase()] || 0) + pstBonus(p, i));
  }
  return score;
}

function search(pos, depth, alpha, beta, ply, ctx) {
  ctx.nodes++;
  if (insufficientMaterial(pos)) return 0;
  if (ctx.nodes > MAX_NODES || depth <= 0) {
    return evaluate(pos) * (pos.wtm ? 1 : -1);
  }

  const moves = legalMoves(pos);
  if (!moves.length) {
    const king = pos.wtm ? pos.wk : pos.bk;
    if (attacked(pos, king, !pos.wtm)) return -MATE + ply;
    return 0;
  }

  moves.sort((a, b) => (pos.sq[b.to] ? VAL[pos.sq[b.to].toUpperCase()] || 0 : 0)
    - (pos.sq[a.to] ? VAL[pos.sq[a.to].toUpperCase()] || 0 : 0));

  let best = -MATE;
  for (const m of moves) {
    const s = -search(apply(pos, m), depth - 1, -beta, -alpha, ply + 1, ctx);
    if (s > best) best = s;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

function scoreToWdl(cp, pos) {
  if (cp > 90000) return [0.97, 0.02, 0.01];
  if (cp < -90000) return [0.01, 0.02, 0.97];
  const mat = remainingMaterial(pos);
  const drawBase = 0.08 + 0.55 * Math.exp(-mat / 800);
  const pd = Math.max(0.015, Math.min(0.94, drawBase * Math.exp(-Math.abs(cp) / 260)));
  const win = 1 / (1 + Math.exp(-cp / 190));
  let pw = win * (1 - pd);
  let pb = (1 - win) * (1 - pd);
  const t = pw + pd + pb;
  return [pw / t, pd / t, pb / t];
}

const DRAWN = [0.02, 0.96, 0.02];
const WHITE_MATE = [0.97, 0.02, 0.01];
const BLACK_MATE = [0.01, 0.02, 0.97];

export function engineEval(fen) {
  const pos = parseFen(fen);
  if (!pos) return null;
  if (insufficientMaterial(pos)) return { cp: 0, wdl: DRAWN, terminal: "draw" };

  const moves = legalMoves(pos);
  if (!moves.length) {
    const king = pos.wtm ? pos.wk : pos.bk;
    if (attacked(pos, king, !pos.wtm)) {
      return pos.wtm
        ? { cp: -MATE, wdl: BLACK_MATE, terminal: "mate" }
        : { cp: MATE, wdl: WHITE_MATE, terminal: "mate" };
    }
    return { cp: 0, wdl: DRAWN, terminal: "stalemate" };
  }

  const ctx = { nodes: 0 };
  const stm = search(pos, DEFAULT_DEPTH, -MATE, MATE, 0, ctx);
  const cp = pos.wtm ? stm : -stm;
  return { cp, wdl: scoreToWdl(cp, pos), terminal: null };
}

// White / Draw / Black probabilities for a FEN, or null if it cannot be parsed.
export function engineWdl(fen) {
  const key = String(fen || "").trim();
  if (!key) return null;
  if (cache.has(key)) return cache.get(key);
  const ev = engineEval(key);
  const wdl = ev ? ev.wdl : null;
  if (cache.size > 256) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
  cache.set(key, wdl);
  return wdl;
}

// Engine WDL when a position exists; Elo prior otherwise.
export function priorForPosition(fen, eloPrior) {
  const fallback = eloPrior || [1 / 3, 1 / 3, 1 / 3];
  if (!fen) return fallback;
  return engineWdl(fen) || fallback;
}
