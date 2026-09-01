// Static-demo wrapper around the in-process alpha-beta.
// Engine WDL when a FEN parses; Elo only when there is no board.

import { engineWdl } from "./engine.js";

// Same numbers as eloPrior(1500, 1500, "blitz") in lib/feed.js — equal
// ratings, no board. Kept here so the Pages demo does not import the
// chess.com poller.
export function equalEloFallback() {
  return [0.45, 0.1, 0.45];
}

export function evaluateDemo(fen, eloFallback) {
  const elo = Array.isArray(eloFallback) && eloFallback.length === 3
    ? eloFallback
    : equalEloFallback();
  const key = String(fen || "").trim();
  if (!key) return { source: "elo", wdl: elo.slice() };
  const wdl = engineWdl(key);
  if (!wdl) return { source: "elo", wdl: elo.slice() };
  return { source: "engine", wdl };
}

export function formatPct(p) {
  return `${(p * 100).toFixed(1)}%`;
}
