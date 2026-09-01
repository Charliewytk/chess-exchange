import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { engineWdl, priorForPosition } from "../lib/engine.js";
import { eloPrior } from "../lib/feed.js";
import { evaluateDemo, equalEloFallback } from "../docs/evaluate.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
// Queen on the back rank: White mates in one (Qe8#).
const MATE_IN_ONE_WHITE = "6k1/8/6K1/8/8/8/8/4Q3 w - - 0 1";
// Same idea, Black to move (Qe1#).
const MATE_IN_ONE_BLACK = "4q3/8/8/8/8/6k1/8/6K1 b - - 0 1";

function roughlyBalanced(wdl) {
  assert.ok(wdl, "expected a WDL vector");
  const [w, d, b] = wdl;
  assert.ok(Math.abs(w + d + b - 1) < 1e-9, `WDL must sum to 1, got ${w + d + b}`);
  // Starting position: neither side is winning; all three outcomes exist.
  assert.ok(w > 0.25 && w < 0.70, `start White should be mid-pack, got ${w}`);
  assert.ok(b > 0.25 && b < 0.70, `start Black should be mid-pack, got ${b}`);
  assert.ok(d > 0.02 && d < 0.40, `start draw should be present but not a dead draw, got ${d}`);
  assert.ok(Math.abs(w - b) < 0.25, `start should be roughly balanced, |W-B|=${Math.abs(w - b)}`);
}

describe("known FEN WDL (in-process alpha-beta)", () => {
  it("starting position is roughly balanced", () => {
    roughlyBalanced(engineWdl(START_FEN));
  });

  it("mate-in-one is ~100% for the winning side", () => {
    const white = engineWdl(MATE_IN_ONE_WHITE);
    assert.ok(white[0] >= 0.95, `White mate-in-one should be ~100% White, got ${white}`);
    assert.ok(white[2] <= 0.03, `losing side should be near zero, got Black ${white[2]}`);

    const black = engineWdl(MATE_IN_ONE_BLACK);
    assert.ok(black[2] >= 0.95, `Black mate-in-one should be ~100% Black, got ${black}`);
    assert.ok(black[0] <= 0.03, `losing side should be near zero, got White ${black[0]}`);
  });

  it("Elo is only the no-board fallback", () => {
    const elo = eloPrior(1500, 1500, "blitz");
    assert.deepEqual(priorForPosition(null, elo), elo);
    assert.deepEqual(priorForPosition("", elo), elo);
    assert.deepEqual(priorForPosition("not-a-fen", elo), elo);

    const fromBoard = priorForPosition(START_FEN, elo);
    assert.notDeepEqual(fromBoard, elo);
    assert.deepEqual(fromBoard, engineWdl(START_FEN));
  });
});

describe("GitHub Pages demo (static FEN → WDL)", () => {
  it("docs/engine.js is a browser-safe copy of lib/engine.js", () => {
    const lib = readFileSync(join(root, "lib/engine.js"), "utf8");
    const copy = readFileSync(join(root, "docs/engine.js"), "utf8");
    assert.equal(copy, lib, "docs/engine.js must match lib/engine.js so Pages and npm start share one eval");
  });

  it("evaluateDemo uses the engine on a FEN and Elo only when there is no board", () => {
    const elo = equalEloFallback();
    const start = evaluateDemo(START_FEN, elo);
    assert.equal(start.source, "engine");
    roughlyBalanced(start.wdl);

    const mate = evaluateDemo(MATE_IN_ONE_WHITE, elo);
    assert.equal(mate.source, "engine");
    assert.ok(mate.wdl[0] >= 0.95);

    const empty = evaluateDemo("", elo);
    assert.equal(empty.source, "elo");
    assert.deepEqual(empty.wdl, elo);

    const junk = evaluateDemo("not-a-fen", elo);
    assert.equal(junk.source, "elo");
    assert.deepEqual(junk.wdl, elo);
  });

  it("static page is honest play-money copy with a later Gumroad slot", () => {
    const html = readFileSync(join(root, "docs/index.html"), "utf8");
    const lower = html.toLowerCase();
    assert.match(lower, /play money/);
    assert.match(lower, /not a book/);
    assert.match(lower, /not (financial |legal |investment )?advice/);
    assert.match(lower, /not affiliated with chess\.com/);
    assert.match(lower, /no real-money wallets/);
    assert.match(lower, /no brokerage/);
    assert.match(lower, /no chess\.com login/);
    assert.match(lower, /no headless bridge/);
    assert.match(lower, /no launchd/);
    assert.doesNotMatch(html, /live p&l|live P&L|\$\d{2,}|profit this week/i);
    assert.match(html, /GUMROAD/);
    assert.doesNotMatch(html, /https:\/\/[\w.-]*gumroad\.com\/l\/[A-Za-z0-9-]+/);
  });
});
