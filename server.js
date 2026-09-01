// Chess Exchange — play-money prediction market on live chess.com games.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Exchange } from "./lib/market.js";
import { ChesscomFeed } from "./lib/feed.js";
import { LichessFeed } from "./lib/lichess.js";
import { ChesscomBridge } from "./lib/bridge.js";
import { plyFromFen, fenMaterialDiff } from "./lib/lichess.js";
import { startBots } from "./lib/bots.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4600;
const PUBLIC = path.join(__dirname, "public");
const DATA_FILE = path.join(__dirname, "data", "state.json");

const log = (msg) => console.log(new Date().toISOString().slice(11, 19), msg);

// ---- SSE hub -------------------------------------------------------------
const clients = new Set();
let snapshotDirty = false;

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}

// ---- engine wiring -------------------------------------------------------
const exchange = new Exchange({
  liquidity: 300,
  startingBalance: 1000,
  onEvent: (ev) => {
    if (ev.type === "trade") broadcast("trade", ev.trade);
    else if (ev.type === "resolve") broadcast("resolve", ev.market);
    snapshotDirty = true;
  },
});

const bridge = new ChesscomBridge({
  profileDir: path.join(__dirname, "data", "brave-profile"),
  log,
});

function bridgeWatch(marketId, legacyId) {
  if (!bridge.canWatch()) return;
  bridge.watch(legacyId, (board) => {
    const m = exchange.markets.get(marketId);
    if (!m || m.status !== "open") { bridge.unwatch(legacyId); return; }
    m.board = board;
    broadcast("board", { marketId, board });
  });
}

const feed = new ChesscomFeed(exchange, {
  onBoard: (ev) => broadcast("board", { marketId: ev.marketId, board: ev.board }),
  onLiveMarket: bridgeWatch,
  log,
});

// Restore persisted accounts (markets are rebuilt from the live feed).
try {
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  for (const a of saved.accounts || []) {
    if (a.name.startsWith("🤖")) continue; // legacy bot accounts
    const acct = exchange.account(a.name);
    acct.balance = a.balance;
    // Legacy records predate deposit tracking: bots' bankroll is capital, not
    // profit, so fall back to their own balance; humans started with the stake.
    acct.deposited = a.deposited ?? (a.isBot ? a.balance : exchange.startingBalance);
    acct.realized = a.realized || 0;
    acct.isBot = !!a.isBot;
  }
  log(`restored ${exchange.accounts.size} accounts`);
} catch { /* first run */ }

const lichess = new LichessFeed(exchange, {
  onBoard: (ev) => broadcast("board", { marketId: ev.marketId, board: ev.board }),
  log,
});

feed.start();
lichess.start();
startBots(exchange, feed, { log });
// Async; enables chess.com live boards when a logged-in profile exists —
// then attach to any live markets that opened before the browser was ready.
bridge.start().then((ok) => {
  if (!ok) return;
  for (const m of exchange.markets.values()) {
    if (m.kind === "live" && m.status === "open" && m.meta.legacyId) {
      bridgeWatch(m.id, m.meta.legacyId);
    }
  }
});

// Persist accounts + push throttled snapshots.
setInterval(() => {
  if (snapshotDirty) {
    snapshotDirty = false;
    broadcast("snapshot", exchange.snapshot());
  }
}, 1200).unref?.();

setInterval(() => {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const accounts = [...exchange.accounts.values()].map((a) => ({
      name: a.name, balance: a.balance, deposited: a.deposited,
      realized: a.realized, isBot: a.isBot,
    }));
    fs.writeFileSync(DATA_FILE, JSON.stringify({ accounts }, null, 1));
  } catch (e) {
    log("persist failed: " + e.message);
  }
}, 20000).unref?.();

// ---- HTTP ----------------------------------------------------------------
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json",
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(body);
}

async function readBody(req) {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 64 * 1024) throw new Error("body too large");
  }
  return data ? JSON.parse(data) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  // CORS for the browser extension (local play-money app; nothing sensitive).
  if (url.pathname.startsWith("/api/")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  }
  try {
    // Board feed from the browser extension: someone watching a chess.com game
    // (logged in, in their own browser) relays the live board here.
    if (url.pathname === "/api/bridge/board" && req.method === "POST") {
      const { legacyId, fen, clocks, labels } = await readBody(req);
      const m = exchange.markets.get("g" + legacyId);
      if (!m || m.status !== "open" || !fen) {
        return json(res, 200, { ok: false, tracked: false });
      }
      m.board = {
        fen,
        ply: plyFromFen(fen),
        totalPlies: null,
        labels: (labels || []).slice(-12),
        clocks: {
          white: clocks?.white ?? m.board?.clocks?.white ?? null,
          black: clocks?.black ?? m.board?.clocks?.black ?? null,
        },
        materialDiff: fenMaterialDiff(fen),
      };
      broadcast("board", { marketId: m.id, board: m.board });
      return json(res, 200, { ok: true, tracked: true, marketId: m.id, prices: exchange.marketPrices(m) });
    }
    // Extension asks: is this game a market? what are the odds?
    if (url.pathname === "/api/bridge/market") {
      const legacyId = url.searchParams.get("legacyId");
      const m = exchange.markets.get("g" + legacyId);
      if (!m) return json(res, 200, { tracked: false });
      return json(res, 200, {
        tracked: true, marketId: m.id, status: m.status, winner: m.winner,
        title: m.title, prices: exchange.marketPrices(m),
      });
    }
    if (url.pathname === "/api/state") {
      return json(res, 200, exchange.snapshot());
    }
    if (url.pathname === "/api/user") {
      const name = url.searchParams.get("name");
      if (!name) return json(res, 400, { error: "name required" });
      return json(res, 200, exchange.userView(name));
    }
    if (url.pathname === "/api/trade" && req.method === "POST") {
      const { user, marketId, outcome, side, amount } = await readBody(req);
      if (!user) return json(res, 400, { error: "pick a name first" });
      if (exchange.accounts.get(String(user).trim())?.isBot) {
        return json(res, 400, { error: "that name belongs to a market-maker bot" });
      }
      const result = side === "sell"
        ? exchange.sell(user, marketId, outcome, amount)
        : exchange.buy(user, marketId, outcome, amount);
      return json(res, 200, { ok: true, ...result, user: exchange.userView(user) });
    }
    if (url.pathname === "/api/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write("retry: 3000\n\n");
      res.write(`event: snapshot\ndata: ${JSON.stringify(exchange.snapshot())}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 15000);
      req.on("close", () => { clearInterval(ping); clients.delete(res); });
      return;
    }

    // static files
    let p = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = path.join(PUBLIC, path.normalize(p));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "text/plain" });
      res.end(buf);
    });
  } catch (e) {
    json(res, 400, { error: e.message });
  }
});

server.listen(PORT, () => log(`chess exchange running on http://localhost:${PORT}`));
