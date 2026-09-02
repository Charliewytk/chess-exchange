import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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

function leftoverCallsGhApiToSetPages(source) {
  if (!/\bgh\s+api\b/.test(source)) return false;
  return /\/pages\b/.test(source) || /\benablement\b/.test(source);
}

function listLeftoverScripts(rootDir) {
  const found = [];
  const scriptsDir = join(rootDir, "scripts");
  for (const name of readdirSync(scriptsDir, { withFileTypes: true })) {
    if (name.isFile()) found.push(join(scriptsDir, name.name));
  }
  for (const name of readdirSync(rootDir, { withFileTypes: true })) {
    if (name.isFile() && name.name.endsWith(".sh")) found.push(join(rootDir, name.name));
  }
  return found;
}

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
    assert.equal(empty.reason, "empty");
    assert.deepEqual(empty.wdl, elo);

    const junk = evaluateDemo("not-a-fen", elo);
    assert.equal(junk.source, "elo");
    assert.equal(junk.reason, "unparseable");
    assert.deepEqual(junk.wdl, elo);

    assert.deepEqual(equalEloFallback(), eloPrior(1500, 1500, "blitz"));
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

  it("GitHub Actions deploys docs/ via upload-pages-artifact and deploy-pages", () => {
    const workflow = readFileSync(join(root, ".github/workflows/pages.yml"), "utf8");
    assert.match(workflow, /actions\/upload-pages-artifact@/);
    assert.match(workflow, /actions\/deploy-pages@/);
    assert.match(workflow, /path:\s*['"]?docs['"]?/);
    assert.match(workflow, /github-pages/);
    assert.match(workflow, /pages:\s*write/);
    assert.match(workflow, /id-token:\s*write/);
    assert.doesNotMatch(workflow, /(?:^|\n)\s+run:\s*npm start\b/);
    assert.doesNotMatch(workflow, /gumroad\.com\/l\//i);
    assert.doesNotMatch(workflow, /Charliewytk\.github\.io/i);

    const readme = readFileSync(join(root, "README.md"), "utf8");
    assert.doesNotMatch(readme, /This repo has no Pages workflow/);
    assert.match(readme, /GitHub Actions/);
    assert.match(readme, /upload-pages-artifact/);
    assert.match(readme, /deploy-pages/);
    assert.match(readme, /play money/i);
    assert.doesNotMatch(readme, /https:\/\/[\w.-]*gumroad\.com\/l\/[A-Za-z0-9-]+/);
  });

  it("README and Pages workflow make Settings → Pages → Source = GitHub Actions unmissable", () => {
    const click = "Settings → Pages → Source = GitHub Actions";
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const workflow = readFileSync(join(root, ".github/workflows/pages.yml"), "utf8");

    const firstHeading = readme.indexOf("\n## ");
    const fold = firstHeading === -1 ? readme : readme.slice(0, firstHeading);
    assert.match(fold, /\[!IMPORTANT\]/);
    assert.match(fold, /agents never click Settings/i);
    assert.ok(fold.includes(click), `README first fold must spell the leftover click as ${click}`);
    assert.match(fold, /https:\/\/github\.com\/Charliewytk\/chess-exchange\/settings\/pages/);
    assert.ok(readme.includes(click), `README must spell the leftover click as ${click}`);

    const workflowComments = workflow
      .split("\n")
      .filter((line) => /^\s*#/.test(line))
      .join("\n");
    const workflowYaml = workflow
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    assert.ok(
      workflowComments.includes(click),
      `pages.yml comments must spell the leftover click as ${click}`,
    );
    assert.match(workflowComments, /agents never click Settings/i);
    assert.doesNotMatch(workflowYaml, /enablement:\s*true/);
    assert.doesNotMatch(workflowYaml, /CHESS\.COM_|PASSWORD|SECRET_KEY|login\.chess/i);
    assert.doesNotMatch(workflow, /launchd/i);
  });

  it("github.io first-fold and demo load graph stay the FEN engine page", () => {
    const html = readFileSync(join(root, "docs/index.html"), "utf8");
    const firstFold = html.split(/<aside\b/)[0];

    assert.match(firstFold, /<title>Chess Exchange — engine demo \(play money\)<\/title>/);
    assert.match(firstFold, /play money · engine demo/);
    assert.match(firstFold, /Paste a FEN/);
    assert.match(firstFold, /id="fen"/);
    assert.match(firstFold, /rnbqkbnr\/pppppppp\/8\/8\/8\/8\/PPPPPPPP\/RNBQKBNR w KQkq - 0 1/);
    assert.match(firstFold, />Evaluate<\/button>/);
    assert.match(firstFold, />Starting position<\/button>/);
    assert.match(firstFold, />Mate in one \(White\)<\/button>/);
    assert.doesNotMatch(firstFold, /Settings → Pages/);
    assert.doesNotMatch(firstFold, /GitHub Actions/);
    assert.doesNotMatch(firstFold, /Gumroad/i);

    assert.match(html, /href="\.\/style\.css"/);
    assert.match(html, /src="\.\/demo\.js"/);
    const demo = readFileSync(join(root, "docs/demo.js"), "utf8");
    const evaluate = readFileSync(join(root, "docs/evaluate.js"), "utf8");
    assert.match(demo, /from ["']\.\/evaluate\.js["']/);
    assert.match(evaluate, /from ["']\.\/engine\.js["']/);
    for (const file of ["docs/style.css", "docs/demo.js", "docs/evaluate.js", "docs/engine.js"]) {
      assert.ok(readFileSync(join(root, file), "utf8").length > 0, `${file} must stay loadable`);
    }
  });

  it("treats gh api Pages enablement as a leftover toggle", () => {
    assert.equal(
      leftoverCallsGhApiToSetPages(
        "gh api -X POST /repos/Charliewytk/chess-exchange/pages -f build_type=workflow",
      ),
      true,
    );
    assert.equal(
      leftoverCallsGhApiToSetPages(
        "gh api repos/Charliewytk/chess-exchange/pages -F enablement=true",
      ),
      true,
    );
    assert.equal(leftoverCallsGhApiToSetPages("console.log('login only')"), false);
    assert.equal(leftoverCallsGhApiToSetPages("gh api user"), false);
  });

  it("leftover scripts do not call gh api to set Pages; deploy stays the Actions path", () => {
    const leftover = listLeftoverScripts(root);
    assert.ok(leftover.length >= 1, "expected the existing scripts/ leftover surface");
    for (const file of leftover) {
      const source = readFileSync(file, "utf8");
      assert.equal(
        leftoverCallsGhApiToSetPages(source),
        false,
        `${file} must not call gh api to set Pages`,
      );
    }

    const workflowNames = readdirSync(join(root, ".github/workflows")).filter(
      (name) => name.endsWith(".yml") || name.endsWith(".yaml"),
    );
    assert.ok(
      workflowNames.includes("pages.yml"),
      "existing Actions deploy path .github/workflows/pages.yml must stay",
    );
    for (const name of workflowNames) {
      const workflow = readFileSync(join(root, ".github/workflows", name), "utf8");
      const workflowYaml = workflow
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n");
      assert.equal(
        leftoverCallsGhApiToSetPages(workflowYaml),
        false,
        `${name} must not call gh api to set Pages`,
      );
      const deploys = /actions\/(?:upload-pages-artifact|deploy-pages)@/.test(workflowYaml);
      if (deploys) {
        assert.match(workflowYaml, /actions\/upload-pages-artifact@/);
        assert.match(workflowYaml, /actions\/deploy-pages@/);
        assert.doesNotMatch(workflowYaml, /enablement:\s*true/);
      }
    }
  });
});
