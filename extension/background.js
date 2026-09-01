// Service worker: proxies fetches to the local exchange so the content script
// isn't subject to chess.com's connect-src CSP.
const BASE = "http://localhost:4600";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "board") {
        const r = await fetch(BASE + "/api/bridge/board", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(msg.data),
        });
        sendResponse(await r.json());
      } else if (msg.type === "market") {
        const r = await fetch(BASE + `/api/bridge/market?legacyId=${encodeURIComponent(msg.legacyId)}`);
        sendResponse(await r.json());
      } else {
        sendResponse({ error: "unknown message" });
      }
    } catch (e) {
      sendResponse({ error: String(e && e.message || e) });
    }
  })();
  return true; // async response
});
