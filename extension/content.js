// Isolated-world content script: relays board state from reader.js to the
// local exchange and renders a small odds overlay on the page.
(() => {
  const BASE = "http://localhost:4600";
  let legacyId = null;
  let tracked = false;
  let lastPrices = null;
  let lastPost = 0;

  function idFromUrl(href) {
    const m = String(href).match(/\/game\/(?:live\/)?(\d+)/);
    return m ? m[1] : null;
  }

  // ---- overlay -----------------------------------------------------------
  const box = document.createElement("div");
  box.style.cssText = `
    position: fixed; right: 14px; bottom: 14px; z-index: 99999;
    background: #171c24ee; color: #e8ecf2; border: 1px solid #2a3342;
    border-radius: 12px; padding: 10px 12px; font: 12px/1.4 -apple-system, sans-serif;
    box-shadow: 0 4px 18px rgba(0,0,0,.5); min-width: 190px; display: none;
  `;
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px">
      <b style="font-size:12px">♞ Chess Exchange</b>
      <span id="cx-dot" style="width:8px;height:8px;border-radius:50%;background:#666"></span>
    </div>
    <div id="cx-prices" style="display:flex;gap:5px;margin-bottom:6px"></div>
    <a id="cx-link" href="${BASE}" target="_blank"
       style="color:#4da3ff;text-decoration:none">trade on the exchange ↗</a>
  `;
  function mountBox() {
    if (document.body && !box.isConnected) document.body.appendChild(box);
  }
  mountBox();

  function renderPrices(prices) {
    const el = box.querySelector("#cx-prices");
    if (!prices) { el.innerHTML = ""; return; }
    const cols = ["#4da3ff", "#a58aff", "#ff7a59"];
    const names = ["White", "Draw", "Black"];
    el.innerHTML = prices.map((p, i) => `
      <div style="flex:1;text-align:center;background:#1e2530;border-radius:6px;padding:3px 4px">
        <div style="font-weight:700;color:${cols[i]}">${Math.round(p * 100)}¢</div>
        <div style="color:#8b96a5;font-size:9px">${names[i]}</div>
      </div>`).join("");
  }

  function setStatus(color, show) {
    box.querySelector("#cx-dot").style.background = color;
    box.style.display = show ? "block" : "none";
  }

  // ---- market lookup -----------------------------------------------------
  async function checkMarket() {
    legacyId = idFromUrl(location.href);
    if (!legacyId) { tracked = false; setStatus("#666", false); return; }
    try {
      const r = await chrome.runtime.sendMessage({ type: "market", legacyId });
      tracked = !!(r && r.tracked && r.status === "open");
      if (r && r.tracked) {
        lastPrices = r.prices;
        renderPrices(r.prices);
        setStatus(tracked ? "#2ecc71" : "#888", true);
      } else {
        renderPrices(null);
        setStatus("#666", false);
      }
    } catch { setStatus("#ff5c5c", !!legacyId); }
  }
  checkMarket();
  setInterval(checkMarket, 7000);

  // ---- board relay -------------------------------------------------------
  window.addEventListener("message", async (ev) => {
    const d = ev.data;
    if (!d || d.source !== "chess-exchange" || !tracked) return;
    const now = Date.now();
    if (now - lastPost < 600) return;
    lastPost = now;
    try {
      const r = await chrome.runtime.sendMessage({
        type: "board",
        data: { legacyId, fen: d.fen, clocks: d.clocks, labels: d.labels },
      });
      if (r && r.ok && r.prices) { lastPrices = r.prices; renderPrices(r.prices); }
    } catch { /* server down — overlay dot handled by checkMarket */ }
  });
})();
