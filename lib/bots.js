// Liquidity bots. They trade toward a noisy belief so prices move and users
// have someone to trade against. When a FEN exists (lichess TV, replays,
// bridged live boards) the belief is the engine WDL for that position; the
// Elo prior is used only when there is no board to evaluate. Clock still
// nudges the engine-less material path. They never see a replay's result.

import { OUTCOMES } from "./market.js";
import { priorForPosition } from "./engine.js";
import { eloPrior } from "./feed.js";

const BOT_BANKROLL = 2500;
const BOT_REFILL_FLOOR = 400;

// Plain names; the UI marks them with a "bot" chip via the isBot flag.
const BOT_NAMES = ["Vega", "Orion", "Atlas", "Juno", "Kite", "Nomad"];

export function startBots(exchange, feed, { log = () => {} } = {}) {
  const bots = BOT_NAMES.map((name, i) => {
    const a = exchange.account(name);
    a.isBot = true;
    // Bots are liquidity providers: they hold a working bankroll rather than a
    // player's stake, and get topped back up when they run it down.
    if (a.balance < BOT_BANKROLL) a.balance = BOT_BANKROLL;
    // At boot a bot holds no positions, so its capital is exactly its cash:
    // its P&L starts each run at zero and only reflects this run's trading.
    a.deposited = a.balance;
    return {
      name,
      aggression: 0.5 + 0.25 * i,       // how hard it trades toward belief
      noise: 0.02 + 0.02 * (i % 3),     // personal price noise
      trust: 0.6 + 0.08 * (i % 4),      // how much it trusts the board signal
    };
  });

  const refill = setInterval(() => {
    for (const b of bots) {
      const a = exchange.account(b.name);
      if (a.balance < BOT_REFILL_FLOOR) {
        a.deposited = (a.deposited ?? 0) + (BOT_BANKROLL - a.balance);
        a.balance = BOT_BANKROLL;
      }
    }
  }, 30000);
  refill.unref?.();

  const timer = setInterval(() => {
    try {
      tick(exchange, feed, bots);
    } catch (e) {
      log("bot error: " + e.message);
    }
  }, 1700);
  timer.unref?.();
  return () => { clearInterval(timer); clearInterval(refill); };
}

function tick(exchange, feed, bots) {
  const open = [...exchange.markets.values()].filter((m) => m.status === "open");
  if (!open.length) return;
  const bot = bots[Math.floor(Math.random() * bots.length)];
  const m = open[Math.floor(Math.random() * open.length)];
  const belief = beliefForMarket(exchange, m, bot);
  if (!belief) return;
  const prices = exchange.marketPrices(m);

  // Find the outcome with the biggest edge.
  let best = -1, bestEdge = 0;
  OUTCOMES.forEach((o, i) => {
    const edge = belief[i] - prices[i];
    if (edge > bestEdge) { bestEdge = edge; best = i; }
  });

  if (best >= 0 && bestEdge > 0.03) {
    const cash = exchange.account(bot.name).balance;
    const spend = Math.min(45, Math.round(bestEdge * 220 * bot.aggression) + 2, Math.floor(cash));
    if (spend >= 1) exchange.buy(bot.name, m.id, OUTCOMES[best], spend);
    return;
  }

  // Occasionally take profits on an overpriced holding.
  const acct = exchange.account(bot.name);
  const pos = acct.positions[m.id];
  if (pos) {
    OUTCOMES.forEach((o, i) => {
      if ((pos[o] || 0) > 4 && prices[i] - belief[i] > 0.05) {
        exchange.sell(bot.name, m.id, o, Math.min(pos[o], 20));
      }
    });
  }
}

function eloForMarket(m) {
  return m.meta.prior
    || eloPrior(m.meta.white?.rating, m.meta.black?.rating, m.meta.timeclass);
}

// Everything knowable about a market right now, from the market itself.
function marketSignals(exchange, m) {
  const elo = eloForMarket(m);
  const fen = m.board?.fen;
  const prior = priorForPosition(fen, elo);
  const usedEngine = Boolean(fen) && prior !== elo;
  if (m.board) {
    const b = m.board;
    const wc = b.clocks?.white, bc = b.clocks?.black;
    const progress = b.totalPlies
      ? b.ply / Math.max(b.totalPlies, 1)
      : Math.min(1, (b.ply || 0) / 80);
    return {
      prior,
      elo,
      usedEngine,
      matDiff: b.materialDiff ?? 0,
      clockDiffFrac: wc != null && bc != null ? (wc - bc) / Math.max(wc, bc, 1) : 0,
      progress,
    };
  }
  return { prior, elo, usedEngine: false, progress: null };
}

// Bot belief for a market. Pass noise: 0 in tests for a deterministic prior.
export function beliefForMarket(exchange, m, bot = { aggression: 1, noise: 0, trust: 1 }) {
  const s = marketSignals(exchange, m);
  if (!s) return null;
  return beliefFrom(s, bot);
}

function beliefFrom(s, bot) {
  let [pw, pd, pb] = s.prior;

  // Engine WDL already prices the position (including draws). Keep the
  // material/clock heuristic only for the Elo-only path (no usable FEN).
  if (!s.usedEngine && s.matDiff !== undefined) {
    // Board signal: material (in pawns) + clock edge, weighted by game progress.
    const progress = Math.min(1, s.progress ?? 0);
    const signal = s.matDiff * 0.55 + (s.clockDiffFrac || 0) * 1.4;
    const shift = Math.tanh(signal * 0.45) * bot.trust * (0.35 + 0.65 * progress);
    if (shift > 0) {
      const take = shift * (pd + pb);
      pw += take; pd -= take * (pd / (pd + pb)); pb -= take * (pb / (pd + pb));
    } else {
      const take = -shift * (pd + pw);
      pb += take; pd -= take * (pd / (pd + pw)); pw -= take * (pw / (pd + pw));
    }
    // Late equal-material games drift toward a draw a bit.
    if (Math.abs(s.matDiff) < 1 && progress > 0.6) {
      const d = 0.06 * (progress - 0.6);
      pd += d; pw -= d / 2; pb -= d / 2;
    }
  }

  // Personal noise.
  pw += (Math.random() - 0.5) * bot.noise * 2;
  pb += (Math.random() - 0.5) * bot.noise * 2;
  pw = Math.max(0.01, pw); pd = Math.max(0.01, pd); pb = Math.max(0.01, pb);
  const t = pw + pd + pb;
  return [pw / t, pd / t, pb / t];
}
