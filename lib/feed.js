// chess.com data feed.
//
// Two sources, both real:
//  - LIVE:   poll the public top-games roster (service/gamelist/top). A market
//            opens when a titled-player game appears and resolves with the
//            official result (callback/live/game/{id}) once the game ends.
//            Guests get no move-by-move access, so live markets trade on
//            players, ratings and elapsed time.
//  - REPLAY: when a live game finishes, chess.com returns its full move list
//            plus per-move clocks. We rebroadcast it move-by-move at true
//            speed with a live board, and the market resolves at the final
//            position. Delayed broadcast of a real game.

import { decodeTCN } from "./tcn.js";
import { Board } from "./board.js";
import { priorForPosition } from "./engine.js";

const UA = "chess-exchange-experiment/0.1 (play-money demo; contact: local)";
const ROSTER_URL = "https://www.chess.com/service/gamelist/top";
const GAME_URL = (id) => `https://www.chess.com/callback/live/game/${id}`;

const ROSTER_INTERVAL = 3500;
const RESOLVE_INTERVAL = 6000;
const MAX_LIVE_MARKETS = 8;
const MAX_REPLAYS = 3;
const VOID_AFTER_MS = 45 * 60 * 1000;

export function eloPrior(whiteRating, blackRating, timeclass) {
  const drawBase = { bullet: 0.05, blitz: 0.1, rapid: 0.16, daily: 0.2 }[timeclass] ?? 0.1;
  const diff = (whiteRating || 1500) - (blackRating || 1500);
  const e = 1 / (1 + Math.pow(10, -diff / 400));
  const d = drawBase * Math.exp(-Math.abs(diff) / 350);
  let pw = Math.max(0.02, e - d / 2);
  let pb = Math.max(0.02, 1 - e - d / 2);
  const s = pw + pb + d;
  return [pw / s, d / s, pb / s];
}

async function getJSON(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export class ChesscomFeed {
  constructor(exchange, { onBoard = () => {}, onLiveMarket = () => {}, log = () => {} } = {}) {
    this.x = exchange;
    this.onBoard = onBoard;
    this.onLiveMarket = onLiveMarket;
    this.log = log;
    this.tracked = new Map(); // legacyId -> {game, marketId, firstSeen, missingSince, attempts}
    this.replayQueue = [];
    this.activeReplays = new Map(); // marketId -> replay state
    this.replayedIds = new Set();
    this.timers = [];
  }

  start() {
    const loop = (fn, ms) => {
      const t = setInterval(() => fn().catch((e) => this.log("feed error: " + e.message)), ms);
      t.unref?.();
      this.timers.push(t);
    };
    loop(() => this.pollRoster(), ROSTER_INTERVAL);
    loop(() => this.pollResolutions(), RESOLVE_INTERVAL);
    loop(async () => this.pumpReplays(), 4000);
    this.pollRoster().catch((e) => this.log("feed error: " + e.message));
  }

  stop() {
    this.timers.forEach(clearInterval);
    for (const r of this.activeReplays.values()) clearTimeout(r.timer);
  }

  // ---- LIVE roster -------------------------------------------------------
  async pollRoster() {
    const roster = await getJSON(ROSTER_URL);
    const seen = new Set();
    let liveCount = [...this.tracked.values()].filter((t) => !t.missingSince).length;

    for (const g of roster) {
      if (g.variant !== "chess" || !g.titled) continue;
      seen.add(g.legacyId);
      const known = this.tracked.get(g.legacyId);
      if (known) {
        known.missingSince = null;
        continue;
      }
      if (liveCount >= MAX_LIVE_MARKETS) continue;
      liveCount++;
      const white = g.players.find((p) => p.color === "white") || g.players[0];
      const black = g.players.find((p) => p.color === "black") || g.players[1];
      const tc = `${Math.round(g.timeControl.base / 60000)}+${Math.round((g.timeControl.increment || 0) / 1000)}`;
      const marketId = "g" + g.legacyId;
      const elo = eloPrior(white.rating, black.rating, g.timeclass);
      this.x.createMarket({
        id: marketId,
        kind: "live",
        title: `${fmtPlayer(white)} vs ${fmtPlayer(black)}`,
        subtitle: `${tc} ${g.timeclass} · live on chess.com`,
        prior: elo,
        meta: {
          prior: elo,
          legacyId: g.legacyId,
          white: pickPlayer(white),
          black: pickPlayer(black),
          timeclass: g.timeclass,
          timeControl: tc,
          baseMs: g.timeControl.base,
          observedAt: Date.now(),
          gameUrl: `https://www.chess.com/game/live/${g.legacyId}`,
        },
      });
      this.tracked.set(g.legacyId, {
        marketId, firstSeen: Date.now(), missingSince: null, attempts: 0,
      });
      this.log(`live market opened: ${white.username} vs ${black.username} (${tc})`);
      this.onLiveMarket(marketId, g.legacyId);
    }

    for (const [legacyId, t] of this.tracked) {
      if (!seen.has(legacyId) && !t.missingSince) {
        t.missingSince = Date.now();
        this.x.setPending(t.marketId);
      }
    }
  }

  // ---- resolution --------------------------------------------------------
  async pollResolutions() {
    // Check the game that has been waiting longest.
    const waiting = [...this.tracked.entries()]
      .filter(([, t]) => t.missingSince)
      .sort((a, b) => (a[1].lastCheck || 0) - (b[1].lastCheck || 0));
    if (!waiting.length) return;
    const [legacyId, t] = waiting[0];
    t.lastCheck = Date.now();

    let data = null;
    try {
      data = await getJSON(GAME_URL(legacyId));
    } catch (e) {
      if (e.status !== 404) this.log(`resolve fetch failed for ${legacyId}: ${e.message}`);
    }

    const game = data?.game;
    if (game?.isFinished) {
      const winner = winnerOf(game);
      this.x.resolve(t.marketId, winner, game.resultMessage || "");
      this.tracked.delete(legacyId);
      this.log(`resolved ${t.marketId}: ${winner} (${game.resultMessage})`);
      if (!this.replayedIds.has(legacyId) && (game.plyCount || 0) >= 12) {
        this.replayQueue.push(game);
        if (this.replayQueue.length > 12) this.replayQueue.shift();
      }
      return;
    }

    if (Date.now() - t.missingSince > VOID_AFTER_MS) {
      this.x.void(t.marketId, "result unavailable — stakes refunded");
      this.tracked.delete(legacyId);
    }
  }

  // ---- replays -----------------------------------------------------------
  async pumpReplays() {
    while (this.activeReplays.size < MAX_REPLAYS && this.replayQueue.length) {
      const game = this.replayQueue.shift();
      if (this.replayedIds.has(game.id)) continue;
      this.replayedIds.add(game.id);
      this.startReplay(game);
    }
  }

  startReplay(game) {
    const h = game.pgnHeaders || {};
    const moves = decodeTCN(game.moveList || "");
    if (!moves.length) return;
    const timestamps = String(game.moveTimestamps || "")
      .split(",").map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
    const baseTenths = (parseInt(String(h.TimeControl).split("+")[0], 10) || 180) * 10;
    const incTenths = (parseInt(String(h.TimeControl).split("+")[1], 10) || 0) * 10;

    const marketId = "r" + game.id;
    const whiteRating = h.WhiteElo || 0, blackRating = h.BlackElo || 0;
    const timeclass = baseTenths <= 1800 ? "bullet" : baseTenths <= 3000 ? "blitz" : "rapid";
    const elo = eloPrior(whiteRating, blackRating, timeclass);
    const board = new Board();
    const prior = priorForPosition(board.fen(), elo);
    const m = this.x.createMarket({
      id: marketId,
      kind: "replay",
      title: `${h.White} (${whiteRating}) vs ${h.Black} (${blackRating})`,
      subtitle: `${h.TimeControl}s ${timeclass} · replay of a real game`,
      prior,
      meta: {
        legacyId: game.id,
        white: { username: h.White, rating: whiteRating },
        black: { username: h.Black, rating: blackRating },
        timeclass,
        timeControl: h.TimeControl,
        prior: elo,
        gameUrl: `https://www.chess.com/game/live/${game.id}`,
        totalPlies: moves.length,
      },
    });

    const state = {
      marketId, game, moves, timestamps, board,
      ply: 0,
      clocks: [baseTenths, baseTenths], // white, black (tenths)
      labels: [],
      timer: null,
    };
    this.activeReplays.set(marketId, state);
    this.publishBoard(m, state);
    this.scheduleNext(state);
    this.log(`replay started: ${m.title}`);
  }

  scheduleNext(state) {
    const { ply, timestamps, clocks } = state;
    if (ply >= state.moves.length) {
      this.finishReplay(state);
      return;
    }
    const colorIdx = ply % 2;
    const after = timestamps[ply];
    let delayTenths = 15;
    if (after != null) {
      const before = clocks[colorIdx];
      delayTenths = Math.max(2, before - after + incTenthsOf(state));
    }
    const delayMs = Math.min(20000, Math.max(400, delayTenths * 100));
    state.timer = setTimeout(() => {
      try {
        this.stepReplay(state);
      } catch (e) {
        this.log("replay error: " + e.message);
        this.finishReplay(state);
      }
    }, delayMs);
    state.timer.unref?.();
  }

  stepReplay(state) {
    const move = state.moves[state.ply];
    const label = state.board.apply(move);
    const colorIdx = state.ply % 2;
    if (state.timestamps[state.ply] != null) {
      state.clocks[colorIdx] = state.timestamps[state.ply];
    }
    state.labels.push(label);
    state.ply++;
    const m = this.x.markets.get(state.marketId);
    if (!m || m.status !== "open") { this.finishReplay(state, true); return; }
    this.publishBoard(m, state);
    this.scheduleNext(state);
  }

  publishBoard(m, state) {
    m.board = {
      fen: state.board.fen(),
      ply: state.ply,
      totalPlies: state.moves.length,
      labels: state.labels.slice(-12),
      clocks: { white: state.clocks[0] / 10, black: state.clocks[1] / 10 },
      materialDiff: Math.round(state.board.materialDiff() * 100) / 100,
    };
    this.onBoard({ type: "board", marketId: m.id, board: m.board });
  }

  finishReplay(state, silent = false) {
    clearTimeout(state.timer);
    this.activeReplays.delete(state.marketId);
    if (silent) return;
    const game = state.game;
    setTimeout(() => {
      this.x.resolve(state.marketId, winnerOf(game), game.resultMessage || "");
      this.log(`replay resolved ${state.marketId}: ${winnerOf(game)}`);
    }, 2500).unref?.();
  }

  // For bots: what is knowable about a market right now.
  beliefState(marketId) {
    const m = this.x.markets.get(marketId);
    if (!m || m.status !== "open") return null;
    const elo = m.meta.prior ||
      eloPrior(m.meta.white?.rating, m.meta.black?.rating, m.meta.timeclass);
    const prior = priorForPosition(m.board?.fen, elo);
    if (m.kind === "replay") {
      const r = this.activeReplays.get(marketId);
      if (!r) return { prior, progress: 1 };
      return {
        prior,
        matDiff: r.board.materialDiff(),
        clockDiffFrac: (r.clocks[0] - r.clocks[1]) / Math.max(r.clocks[0], r.clocks[1], 1),
        progress: r.ply / Math.max(r.moves.length, 1),
      };
    }
    return { prior, progress: null };
  }
}

function incTenthsOf(state) {
  const inc = String(state.game.pgnHeaders?.TimeControl || "").split("+")[1];
  return (parseInt(inc, 10) || 0) * 10;
}

function winnerOf(game) {
  if (game.colorOfWinner === "white" || game.colorOfWinner === "black") {
    return game.colorOfWinner;
  }
  const r = game.pgnHeaders?.Result;
  if (r === "1-0") return "white";
  if (r === "0-1") return "black";
  return "draw";
}

function fmtPlayer(p) {
  return `${p.title ? p.title + " " : ""}${p.username} (${p.rating})`;
}

function pickPlayer(p) {
  return { username: p.username, title: p.title, rating: p.rating, country: p.country };
}
