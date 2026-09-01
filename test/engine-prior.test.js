import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { eloPrior } from "../lib/feed.js";
import { engineWdl, priorForPosition } from "../lib/engine.js";
import { beliefForMarket } from "../lib/bots.js";
import { Exchange } from "../lib/market.js";

// Queen + king vs lone king: a known win for White.
const WHITE_WIN_FEN = "4k3/8/8/8/8/8/8/4K2Q w - - 0 1";
// Dead draw: king vs king.
const KV_K_FEN = "8/8/8/8/8/8/8/4K2k w - - 0 1";

const QUIET_BOT = { aggression: 1, noise: 0, trust: 1 };

function market(prior, board) {
  const x = new Exchange();
  const m = x.createMarket({
    id: "t1",
    title: "test",
    prior,
    meta: { prior, white: { rating: 2000 }, black: { rating: 2000 }, timeclass: "blitz" },
  });
  if (board) m.board = board;
  return { x, m };
}

describe("engine-informed draw/win prior", () => {
  const elo = eloPrior(2000, 2000, "blitz");

  it("winning FEN: draw and losing-side prices fall vs the Elo-only prior", () => {
    const engine = priorForPosition(WHITE_WIN_FEN, elo);
    assert.ok(engineWdl(WHITE_WIN_FEN), "engine must evaluate the winning FEN");
    assert.ok(engine[1] < elo[1], `draw ${engine[1]} should be < elo draw ${elo[1]}`);
    assert.ok(engine[2] < elo[2], `black ${engine[2]} should be < elo black ${elo[2]}`);
    assert.ok(engine[0] > elo[0], `white ${engine[0]} should rise vs elo white ${elo[0]}`);

    const { x, m } = market(elo, { fen: WHITE_WIN_FEN });
    const belief = beliefForMarket(x, m, QUIET_BOT);
    assert.ok(belief[1] < elo[1], "bot draw belief falls vs Elo");
    assert.ok(belief[2] < elo[2], "bot losing-side belief falls vs Elo");
  });

  it("dead-drawn FEN (K vs K): draw price rises vs the Elo-only prior", () => {
    const engine = priorForPosition(KV_K_FEN, elo);
    assert.ok(engine[1] > elo[1], `draw ${engine[1]} should be > elo draw ${elo[1]}`);
    assert.ok(engine[1] > 0.8, `K vs K draw should dominate, got ${engine[1]}`);

    const { x, m } = market(elo, { fen: KV_K_FEN });
    const belief = beliefForMarket(x, m, QUIET_BOT);
    assert.ok(belief[1] > elo[1], "bot draw belief rises vs Elo");
  });

  it("Elo prior is used when no FEN is available", () => {
    assert.deepEqual(priorForPosition(null, elo), elo);
    assert.deepEqual(priorForPosition(undefined, elo), elo);
    assert.deepEqual(priorForPosition("", elo), elo);
    assert.deepEqual(priorForPosition("not-a-fen", elo), elo);

    const { x, m } = market(elo, null);
    const belief = beliefForMarket(x, m, QUIET_BOT);
    assert.deepEqual(belief, elo);

    // Board present but no FEN — still Elo, not a made-up engine prior.
    m.board = { materialDiff: 0, ply: 10 };
    const noFen = priorForPosition(m.board.fen, elo);
    assert.deepEqual(noFen, elo);
  });

  it("a market seeded from a FEN does not price the draw from ratings alone", () => {
    const engine = priorForPosition(KV_K_FEN, elo);
    const x = new Exchange();
    const m = x.createMarket({
      id: "tv1",
      title: "lichess-style",
      kind: "tv",
      prior: engine,
      meta: { prior: elo },
    });
    const prices = x.marketPrices(m);
    assert.ok(prices[1] > elo[1], "LMSR draw is above the Elo draw prior");
    assert.ok(Math.abs(prices[1] - engine[1]) < 1e-9, "LMSR draw matches engine WDL");
  });
});
