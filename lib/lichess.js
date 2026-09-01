// Lichess TV feed — true live markets with live boards.
//
// Lichess exposes a public streaming API for its featured "TV" games per speed
// channel: an ndjson stream of the current featured game and a FEN + clocks
// event for every move, no auth required. When the featured game changes we
// keep polling the old game until it has an official result, then resolve.

import { eloPrior } from "./feed.js";

const CHANNELS = ["bullet", "blitz", "rapid"];
const FEED_URL = (ch) => `https://lichess.org/api/tv/${ch}/feed`;
const EXPORT_URL = (id) => `https://lichess.org/game/export/${id}`;
const UA = "chess-exchange-experiment/0.1 (play-money demo)";

const DRAW_STATUSES = new Set(["draw", "stalemate"]);
const VOID_STATUSES = new Set(["aborted", "noStart"]);

export class LichessFeed {
  constructor(exchange, { onBoard = () => {}, log = () => {} } = {}) {
    this.x = exchange;
    this.onBoard = onBoard;
    this.log = log;
    this.current = new Map();  // channel -> {gameId, marketId}
    this.pending = [];         // [{gameId, marketId, since}]
    this.stopped = false;
    this.timers = [];
  }

  start() {
    for (const ch of CHANNELS) this.streamChannel(ch);
    const t = setInterval(() => {
      this.pollResults().catch((e) => this.log("lichess resolve error: " + e.message));
    }, 5000);
    t.unref?.();
    this.timers.push(t);
  }

  stop() {
    this.stopped = true;
    this.timers.forEach(clearInterval);
  }

  async streamChannel(channel) {
    while (!this.stopped) {
      try {
        const res = await fetch(FEED_URL(channel), {
          headers: { "User-Agent": UA },
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) this.handleEvent(channel, JSON.parse(line));
          }
        }
      } catch (e) {
        if (!this.stopped) this.log(`lichess ${channel} stream error: ${e.message}`);
      }
      if (this.stopped) return;
      await new Promise((r) => setTimeout(r, 4000 + Math.random() * 3000));
    }
  }

  handleEvent(channel, ev) {
    if (ev.t === "featured") this.onFeatured(channel, ev.d);
    else if (ev.t === "fen") this.onFen(channel, ev.d);
  }

  onFeatured(channel, d) {
    const prev = this.current.get(channel);
    if (prev && prev.gameId !== d.id) {
      // Old featured game left TV — await its official result.
      this.pending.push({ gameId: prev.gameId, marketId: prev.marketId, since: Date.now() });
    }
    if (prev && prev.gameId === d.id) return; // reconnect of same game

    const white = d.players.find((p) => p.color === "white");
    const black = d.players.find((p) => p.color === "black");
    const marketId = "l" + d.id;
    const prior = eloPrior(white.rating, black.rating, channel);
    const m = this.x.createMarket({
      id: marketId,
      kind: "tv",
      title: `${fmtPlayer(white)} vs ${fmtPlayer(black)}`,
      subtitle: `${channel} · live on lichess TV`,
      prior,
      meta: {
        gameId: d.id,
        channel,
        white: pickPlayer(white),
        black: pickPlayer(black),
        timeclass: channel,
        prior,
        gameUrl: `https://lichess.org/${d.id}`,
        observedAt: Date.now(),
      },
    });
    this.current.set(channel, { gameId: d.id, marketId });
    this.publishBoard(m, {
      fen: d.fen,
      wc: white.seconds,
      bc: black.seconds,
      lm: null,
    });
    this.log(`lichess ${channel} market: ${m.title}`);
  }

  onFen(channel, d) {
    const cur = this.current.get(channel);
    if (!cur) return;
    const m = this.x.markets.get(cur.marketId);
    if (!m || m.status !== "open") return;
    this.publishBoard(m, d);
  }

  publishBoard(m, d) {
    const ply = plyFromFen(d.fen);
    m.board = {
      fen: d.fen,
      ply,
      totalPlies: null,
      labels: d.lm ? [(m.board?.labels || []).slice(-11), d.lm].flat() : (m.board?.labels || []),
      clocks: { white: d.wc ?? m.board?.clocks?.white ?? null, black: d.bc ?? m.board?.clocks?.black ?? null },
      materialDiff: fenMaterialDiff(d.fen),
    };
    this.onBoard({ type: "board", marketId: m.id, board: m.board });
  }

  async pollResults() {
    if (!this.pending.length) return;
    const item = this.pending.shift();
    let game = null;
    try {
      const res = await fetch(EXPORT_URL(item.gameId), {
        headers: { Accept: "application/json", "User-Agent": UA },
        signal: AbortSignal.timeout(9000),
      });
      if (res.ok) game = await res.json();
    } catch { /* retry below */ }

    const status = game?.status;
    if (!status || status === "started" || status === "created") {
      if (Date.now() - item.since > 30 * 60 * 1000) {
        this.x.void(item.marketId, "result unavailable — stakes refunded");
      } else {
        this.pending.push(item); // check again later
      }
      return;
    }
    if (VOID_STATUSES.has(status)) {
      this.x.void(item.marketId, "game aborted — stakes refunded");
      return;
    }
    const winner = game.winner === "white" || game.winner === "black"
      ? game.winner
      : DRAW_STATUSES.has(status) ? "draw" : "draw";
    this.x.resolve(item.marketId, winner, `${status}${game.winner ? " — " + game.winner + " won" : ""}`);
    this.log(`lichess resolved ${item.marketId}: ${winner} (${status})`);
  }
}

function fmtPlayer(p) {
  const t = p.user?.title ? p.user.title + " " : "";
  return `${t}${p.user?.name || "?"} (${p.rating || "?"})`;
}

function pickPlayer(p) {
  return { username: p.user?.name, title: p.user?.title, rating: p.rating };
}

export function plyFromFen(fen) {
  const parts = fen.split(" ");
  const fullmove = parseInt(parts[5], 10) || 1;
  return (fullmove - 1) * 2 + (parts[1] === "b" ? 1 : 0);
}

const VALUES = { p: 1, n: 3, b: 3.15, r: 5, q: 9, k: 0 };
export function fenMaterialDiff(fen) {
  let diff = 0;
  for (const ch of fen.split(" ")[0]) {
    const v = VALUES[ch.toLowerCase()];
    if (v === undefined) continue;
    diff += ch === ch.toUpperCase() ? v : -v;
  }
  return Math.round(diff * 100) / 100;
}
