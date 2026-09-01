// LMSR (logarithmic market scoring rule) prediction market engine with
// play-money accounts. Prices behave like Polymarket: each outcome share
// pays out 1 chip if that outcome happens, and its price is a probability.

export const OUTCOMES = ["white", "draw", "black"];

function logSumExp(xs) {
  const m = Math.max(...xs);
  return m + Math.log(xs.reduce((s, x) => s + Math.exp(x - m), 0));
}

export class Exchange {
  constructor({ liquidity = 300, startingBalance = 1000, onEvent = () => {} } = {}) {
    this.b = liquidity;
    this.startingBalance = startingBalance;
    this.onEvent = onEvent;
    this.accounts = new Map(); // name -> {balance, positions, netSpend, realized}
    this.markets = new Map();  // id -> market
    this.trades = [];          // recent trade log
  }

  // ---- accounts ----------------------------------------------------------
  account(name) {
    name = String(name || "").trim().slice(0, 24);
    if (!name) throw new Error("name required");
    let a = this.accounts.get(name);
    if (!a) {
      a = { name, balance: this.startingBalance, deposited: this.startingBalance,
            positions: {}, netSpend: {}, realized: 0, isBot: false };
      this.accounts.set(name, a);
    }
    return a;
  }

  // ---- markets -----------------------------------------------------------
  createMarket({ id, title, subtitle, kind, meta = {}, prior = [1 / 3, 1 / 3, 1 / 3] }) {
    if (this.markets.has(id)) return this.markets.get(id);
    const b = this.b;
    // Seed q so that initial prices equal the prior.
    const q = prior.map((p) => b * Math.log(Math.max(p, 1e-4)));
    const m = {
      id, title, subtitle, kind, meta,
      status: "open", // open | pending | resolved | void
      q, b,
      createdAt: Date.now(),
      resolvedAt: null,
      winner: null,
      volume: 0,
      history: [{ t: Date.now(), p: this.prices(q, b) }],
      board: null, // {fen, lastLabel, ply, clocks:{white,black}, labels:[]}
    };
    this.markets.set(id, m);
    this.onEvent({ type: "market", market: this.publicMarket(m) });
    return m;
  }

  prices(q, b) {
    const l = logSumExp(q.map((x) => x / b));
    return q.map((x) => Math.exp(x / b - l));
  }

  marketPrices(m) {
    return this.prices(m.q, m.b);
  }

  cost(q, b) {
    return b * logSumExp(q.map((x) => x / b));
  }

  // Buy `spend` chips worth of `outcome`. Returns shares bought.
  buy(name, marketId, outcome, spend) {
    const m = this.markets.get(marketId);
    const a = this.account(name);
    const oi = OUTCOMES.indexOf(outcome);
    if (!m) throw new Error("market not found");
    if (m.status !== "open") throw new Error("market closed");
    if (oi < 0) throw new Error("bad outcome");
    spend = Number(spend);
    if (!(spend > 0)) throw new Error("bad amount");
    if (spend > a.balance + 1e-9) throw new Error("insufficient balance");

    const { q, b } = m;
    // Closed form: after spending `spend`, sum of exp goes up by factor e^{spend/b}.
    const l = logSumExp(q.map((x) => x / b));
    const expSumOthers = OUTCOMES.reduce(
      (s, _, j) => (j === oi ? s : s + Math.exp(q[j] / b - l)), 0);
    const newExpI = Math.exp(spend / b) - expSumOthers; // relative to e^l
    if (newExpI <= 0) throw new Error("amount too small");
    const newQi = b * (Math.log(newExpI) + l);
    const shares = newQi - q[oi];
    if (!(shares > 0)) throw new Error("amount too small");

    q[oi] = newQi;
    a.balance -= spend;
    a.positions[marketId] = a.positions[marketId] || { white: 0, draw: 0, black: 0 };
    a.positions[marketId][outcome] += shares;
    a.netSpend[marketId] = (a.netSpend[marketId] || 0) + spend;
    m.volume += spend;
    this.recordTrade(m, a, "buy", outcome, shares, spend);
    return { shares, spend };
  }

  // Sell `shares` of `outcome`; returns proceeds.
  sell(name, marketId, outcome, shares) {
    const m = this.markets.get(marketId);
    const a = this.account(name);
    const oi = OUTCOMES.indexOf(outcome);
    if (!m) throw new Error("market not found");
    if (m.status !== "open") throw new Error("market closed");
    if (oi < 0) throw new Error("bad outcome");
    shares = Number(shares);
    const held = a.positions[marketId]?.[outcome] || 0;
    if (!(shares > 0)) throw new Error("bad amount");
    if (shares > held + 1e-9) throw new Error("not enough shares");
    shares = Math.min(shares, held);

    const { q, b } = m;
    const before = this.cost(q, b);
    q[oi] -= shares;
    const proceeds = before - this.cost(q, b);
    a.balance += proceeds;
    a.positions[marketId][outcome] -= shares;
    a.netSpend[marketId] = (a.netSpend[marketId] || 0) - proceeds;
    m.volume += proceeds;
    this.recordTrade(m, a, "sell", outcome, shares, proceeds);
    return { shares, proceeds };
  }

  recordTrade(m, a, side, outcome, shares, chips) {
    const p = this.marketPrices(m);
    m.history.push({ t: Date.now(), p });
    if (m.history.length > 900) m.history.splice(0, m.history.length - 700);
    const trade = {
      t: Date.now(), marketId: m.id, user: a.name, isBot: a.isBot,
      side, outcome, shares: round2(shares), chips: round2(chips),
      prices: p.map((x) => round4(x)),
    };
    this.trades.push(trade);
    if (this.trades.length > 400) this.trades.splice(0, this.trades.length - 300);
    this.onEvent({ type: "trade", trade });
  }

  setPending(marketId) {
    const m = this.markets.get(marketId);
    if (m && m.status === "open") {
      // Trading stays open while we await the official result; just flag it.
      m.meta.awaitingResult = true;
      this.onEvent({ type: "market", market: this.publicMarket(m) });
    }
  }

  resolve(marketId, winner /* "white" | "draw" | "black" */, resultText = "") {
    const m = this.markets.get(marketId);
    if (!m || m.status === "resolved" || m.status === "void") return;
    m.status = "resolved";
    m.winner = winner;
    m.resolvedAt = Date.now();
    m.meta.resultText = resultText;
    for (const a of this.accounts.values()) {
      const pos = a.positions[marketId];
      if (!pos) continue;
      const payout = pos[winner] || 0;
      const spent = a.netSpend[marketId] || 0;
      if (payout > 0) a.balance += payout;
      a.realized += payout - spent;
      delete a.positions[marketId];
      delete a.netSpend[marketId];
    }
    this.onEvent({ type: "resolve", market: this.publicMarket(m) });
  }

  void(marketId, reason = "") {
    const m = this.markets.get(marketId);
    if (!m || m.status === "resolved" || m.status === "void") return;
    m.status = "void";
    m.resolvedAt = Date.now();
    m.meta.resultText = reason || "market voided — stakes refunded";
    for (const a of this.accounts.values()) {
      const spent = a.netSpend[marketId] || 0;
      if (spent) a.balance += spent;
      delete a.positions[marketId];
      delete a.netSpend[marketId];
    }
    this.onEvent({ type: "resolve", market: this.publicMarket(m) });
  }

  // ---- serialization -----------------------------------------------------
  publicMarket(m) {
    return {
      id: m.id, title: m.title, subtitle: m.subtitle, kind: m.kind,
      status: m.status, winner: m.winner, meta: m.meta,
      createdAt: m.createdAt, resolvedAt: m.resolvedAt,
      volume: round2(m.volume),
      q: m.q.map((x) => round4(x)), b: m.b,
      prices: this.marketPrices(m).map((x) => round4(x)),
      history: m.history.slice(-240),
      board: m.board,
    };
  }

  snapshot() {
    const markets = [...this.markets.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 60)
      .map((m) => this.publicMarket(m));
    const leaderboard = [...this.accounts.values()]
      .map((a) => {
        const equity = a.balance + this.positionsValue(a);
        return {
          name: a.name, isBot: a.isBot,
          balance: round2(a.balance),
          equity: round2(equity),
          pnl: round2(equity - (a.deposited ?? this.startingBalance)),
          realized: round2(a.realized),
        };
      })
      .sort((x, y) => y.pnl - x.pnl)
      .slice(0, 30);
    return { markets, leaderboard, trades: this.trades.slice(-60) };
  }

  positionsValue(a) {
    let v = 0;
    for (const [mid, pos] of Object.entries(a.positions)) {
      const m = this.markets.get(mid);
      if (!m || m.status !== "open") continue;
      const p = this.marketPrices(m);
      OUTCOMES.forEach((o, i) => { v += (pos[o] || 0) * p[i]; });
    }
    return v;
  }

  userView(name) {
    const a = this.account(name);
    const positions = Object.entries(a.positions).map(([mid, pos]) => {
      const m = this.markets.get(mid);
      const p = m ? this.marketPrices(m) : [0, 0, 0];
      return {
        marketId: mid,
        title: m?.title || mid,
        shares: { white: round2(pos.white), draw: round2(pos.draw), black: round2(pos.black) },
        value: round2(OUTCOMES.reduce((s, o, i) => s + (pos[o] || 0) * p[i], 0)),
        netSpend: round2(a.netSpend[mid] || 0),
      };
    });
    return {
      name: a.name,
      balance: round2(a.balance),
      equity: round2(a.balance + this.positionsValue(a)),
      realized: round2(a.realized),
      positions,
    };
  }
}

function round2(x) { return Math.round(x * 100) / 100; }
function round4(x) { return Math.round(x * 10000) / 10000; }
