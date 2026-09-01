// Runs in the page's MAIN world so it can reach the chessboard component API.
// Posts board state to the isolated content script via window.postMessage.
(() => {
  if (window.__cxReader) return;
  window.__cxReader = true;

  function parseClock(text) {
    if (!text) return null;
    const m = String(text).trim().match(/(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/);
    if (!m) return null;
    const h = m[1] ? parseInt(m[1], 10) : 0;
    return h * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
  }

  setInterval(() => {
    try {
      const b = document.querySelector("wc-chess-board");
      if (!b || !b.game || !b.game.getFEN) return;
      let flipped = false;
      try { flipped = b.game.getOptions().flipped === true; } catch { /* default */ }
      // Find clock-ish elements without depending on exact class names:
      // small elements whose text looks like a clock, classified top/bottom by
      // their vertical position relative to the board.
      const boardRect = b.getBoundingClientRect();
      const mid = boardRect.top + boardRect.height / 2;
      let top = null, bottom = null;
      for (const el of document.querySelectorAll("[class*='clock'],[data-cy*='clock']")) {
        const text = (el.textContent || "").trim();
        if (text.length > 12) continue;
        const secs = parseClock(text);
        if (secs == null) continue;
        const r = el.getBoundingClientRect();
        if (!r.height) continue;
        if (r.top + r.height / 2 < mid) top = secs;
        else bottom = secs;
      }
      const clocks = flipped
        ? { white: top, black: bottom }
        : { white: bottom, black: top };
      let labels = [];
      try { labels = b.game.getHistorySANs().slice(-12); } catch { /* optional */ }
      window.postMessage({
        source: "chess-exchange",
        fen: b.game.getFEN(),
        clocks,
        labels,
        href: location.href,
      }, "*");
    } catch { /* board not ready */ }
  }, 700);
})();
