// Minimal Chrome DevTools Protocol client over Node's built-in WebSocket.
// Enough to launch a Chromium-based browser (Brave), open tabs, and evaluate
// JavaScript in them. No npm dependencies.

import { spawn } from "node:child_process";

export const BRAVE_PATHS = [
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

export function launchBrowser({ binary, profileDir, headless = true, startUrl }) {
  const args = [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--mute-audio",
    "--window-size=1200,900",
  ];
  if (headless) args.push("--headless=new");
  if (startUrl) args.push(startUrl);

  const proc = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
  const wsUrl = new Promise((resolve, reject) => {
    let buf = "";
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) resolve(m[1]);
    };
    proc.stderr.on("data", onData);
    proc.stdout.on("data", onData);
    proc.on("exit", (code) => reject(new Error("browser exited " + code)));
    setTimeout(() => reject(new Error("browser did not start in time")), 20000);
  });
  return { proc, wsUrl };
}

export class CDP {
  constructor() {
    this.msgId = 0;
    this.pending = new Map();
    this.eventHandlers = [];
  }

  async connect(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error("CDP connect failed"));
    });
    this.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        for (const h of this.eventHandlers) h(msg);
      }
    };
  }

  send(method, params = {}, sessionId) {
    const id = ++this.msgId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(method + " timed out"));
      }, 15000);
    });
  }

  onEvent(handler) {
    this.eventHandlers.push(handler);
  }

  // Open a tab and return {targetId, sessionId}.
  async openTab(url) {
    const { targetId } = await this.send("Target.createTarget", { url });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    return { targetId, sessionId };
  }

  async closeTab(targetId) {
    await this.send("Target.closeTarget", { targetId }).catch(() => {});
  }

  // Evaluate an expression in a tab; returns the JSON value.
  async eval(sessionId, expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, sessionId);
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description?.slice(0, 200) || "eval failed");
    }
    return r.result?.value;
  }

  async getCookies(sessionId, urls) {
    const r = await this.send("Network.getCookies", urls ? { urls } : {}, sessionId);
    return r.cookies || [];
  }

  close() {
    try { this.ws?.close(); } catch { /* noop */ }
  }
}
