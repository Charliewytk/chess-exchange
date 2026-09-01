// chess.com live-board bridge.
//
// chess.com only streams live moves to logged-in sessions, so this module
// drives a headless Brave/Chrome with a persistent profile. If the profile is
// logged in to chess.com (run `npm run login` once — you type your own
// credentials into the real chess.com page; nothing is stored here), the
// bridge opens /game/live/{id} pages for tracked games and reads the board
// state straight from the page's chessboard component, giving LIVE markets a
// real-time board just like the lichess TV feed.
//
// Without a logged-in profile the bridge detects the guest redirect and shuts
// down quietly — the app works fine without it.

import fs from "node:fs";
import { CDP, BRAVE_PATHS, launchBrowser } from "./cdp.js";
import { fenMaterialDiff, plyFromFen } from "./lichess.js";

const MAX_TABS = 3;
const POLL_MS = 900;

export class ChesscomBridge {
  constructor({ profileDir, log = () => {} }) {
    this.profileDir = profileDir;
    this.log = log;
    this.cdp = null;
    this.proc = null;
    this.ready = false;       // browser up
    this.loggedIn = false;    // chess.com session present
    this.watchers = new Map(); // legacyId -> {targetId, sessionId, timer, onUpdate}
  }

  binary() {
    return BRAVE_PATHS.find((p) => fs.existsSync(p)) || null;
  }

  async start() {
    const binary = this.binary();
    if (!binary) {
      this.log("bridge: no Chromium-based browser found — live boards for chess.com disabled");
      return false;
    }
    fs.mkdirSync(this.profileDir, { recursive: true });
    try {
      const { proc, wsUrl } = launchBrowser({
        binary, profileDir: this.profileDir, headless: true,
      });
      this.proc = proc;
      this.cdp = new CDP();
      await this.cdp.connect(await wsUrl);
      this.ready = true;

      // Login check: load chess.com and look for a session.
      const { targetId, sessionId } = await this.cdp.openTab("https://www.chess.com/home");
      await sleep(4000);
      const info = await this.cdp.eval(sessionId, `JSON.stringify({
        path: location.pathname,
        user: (window.context && window.context.user && window.context.user.username) || null,
        hasLogin: !!document.querySelector("a[href*='login']"),
      })`).then(JSON.parse).catch(() => null);
      await this.cdp.closeTab(targetId);

      this.loggedIn = !!(info && (info.user || (info.path === "/home" && !info.hasLogin)));
      this.log(this.loggedIn
        ? `bridge: chess.com session active${info.user ? " as " + info.user : ""} — live boards ON`
        : "bridge: no chess.com login in profile — run `npm run login` to enable live boards");
      if (!this.loggedIn) this.shutdown();
      return this.loggedIn;
    } catch (e) {
      this.log("bridge failed to start: " + e.message);
      this.shutdown();
      return false;
    }
  }

  canWatch() {
    return this.ready && this.loggedIn && this.watchers.size < MAX_TABS;
  }

  async watch(legacyId, onUpdate) {
    if (!this.canWatch() || this.watchers.has(legacyId)) return false;
    const entry = { targetId: null, sessionId: null, timer: null, onUpdate, failures: 0 };
    this.watchers.set(legacyId, entry);
    try {
      const tab = await this.cdp.openTab(`https://www.chess.com/game/live/${legacyId}`);
      entry.targetId = tab.targetId;
      entry.sessionId = tab.sessionId;
      await sleep(3500);
      entry.timer = setInterval(() => this.poll(legacyId).catch(() => {}), POLL_MS);
      entry.timer.unref?.();
      this.log(`bridge: watching game ${legacyId}`);
      return true;
    } catch (e) {
      this.log(`bridge: failed to watch ${legacyId}: ${e.message}`);
      this.unwatch(legacyId);
      return false;
    }
  }

  async poll(legacyId) {
    const w = this.watchers.get(legacyId);
    if (!w || !w.sessionId) return;
    let data = null;
    try {
      data = await this.cdp.eval(w.sessionId, `(() => {
        const b = document.querySelector("wc-chess-board");
        if (!b || !b.game) return JSON.stringify({ err: "noboard", path: location.pathname });
        const clocks = [...document.querySelectorAll("[class*='clock-time'],[data-cy*='clock']")]
          .map(e => (e.textContent || "").trim()).filter(Boolean).slice(0, 4);
        return JSON.stringify({
          path: location.pathname,
          fen: b.game.getFEN(),
          sans: b.game.getHistorySANs().slice(-12),
          clocks,
        });
      })()`).then(JSON.parse);
    } catch {
      w.failures++;
      if (w.failures > 8) this.unwatch(legacyId);
      return;
    }
    if (!data || data.err || !String(data.path).includes(String(legacyId))) {
      // Redirected (game over) or board gone — stop; the roster/resolver flow
      // owns the market lifecycle.
      this.unwatch(legacyId);
      return;
    }
    w.failures = 0;
    const clocks = parseClocks(data.clocks);
    w.onUpdate({
      fen: data.fen,
      ply: plyFromFen(data.fen),
      totalPlies: null,
      labels: data.sans || [],
      clocks,
      materialDiff: fenMaterialDiff(data.fen),
    });
  }

  unwatch(legacyId) {
    const w = this.watchers.get(legacyId);
    if (!w) return;
    clearInterval(w.timer);
    if (w.targetId) this.cdp?.closeTab(w.targetId);
    this.watchers.delete(legacyId);
  }

  shutdown() {
    for (const id of [...this.watchers.keys()]) this.unwatch(id);
    this.cdp?.close();
    try { this.proc?.kill(); } catch { /* noop */ }
    this.ready = false;
  }
}

// ["2:58.1", "3:00"] on the page, top clock is the opponent (black when white
// is at the bottom, which is the default for spectators… orientation varies,
// so treat first=black, second=white and accept occasional swaps).
function parseClocks(texts) {
  const secs = (texts || []).map((t) => {
    const m = String(t).match(/(\d+):(\d+(?:\.\d+)?)/);
    return m ? parseInt(m[1], 10) * 60 + parseFloat(m[2]) : null;
  }).filter((x) => x != null);
  if (secs.length < 2) return { white: null, black: null };
  return { black: secs[0], white: secs[secs.length - 1] };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
