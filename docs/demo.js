import { evaluateDemo, formatPct } from "./evaluate.js";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const MATE_IN_ONE_WHITE = "6k1/8/6K1/8/8/8/8/4Q3 w - - 0 1";

const $ = (id) => document.getElementById(id);

function render(result) {
  const [w, d, b] = result.wdl;
  $("pw").textContent = formatPct(w);
  $("pd").textContent = formatPct(d);
  $("pb").textContent = formatPct(b);
  $("bw").style.flex = String(w);
  $("bd").style.flex = String(d);
  $("bb").style.flex = String(b);
  $("source").textContent = result.source === "engine"
    ? "Source: in-process alpha-beta (lib/engine.js)."
    : result.reason === "unparseable"
      ? "FEN did not parse — Elo fallback only (equal 1500s, blitz draw rate)."
      : "No board to evaluate — Elo fallback only (equal 1500s, blitz draw rate).";
}

function run() {
  render(evaluateDemo($("fen").value));
}

$("eval").onclick = run;
$("start").onclick = () => { $("fen").value = START_FEN; run(); };
$("mate").onclick = () => { $("fen").value = MATE_IN_ONE_WHITE; run(); };
$("fen").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run();
});

run();
