/* Chess Exchange frontend — board-first rails UI */
const OUTCOMES = ["white", "draw", "black"];
const OUT_LABEL = { white: "White", draw: "Draw", black: "Black" };
const OUT_CLASS = { white: "w", draw: "d", black: "b" };
const COLORS = { white: "#0a84ff", draw: "#bf5af0", black: "#ff9f0a" };
// Solid glyphs for both colors; color comes from CSS (.wp/.bp) so pieces
// stay high-contrast regardless of platform font rendering.
const GLYPH = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w";

const $ = (id) => document.getElementById(id);
let state = { markets: [], leaderboard: [], trades: [] };
let me = { name: localStorage.getItem("cx-name") || "", balance: null };
let detail = { id: null, outcome: "white", side: "buy" };

// ---- identity ------------------------------------------------------------
function ensureName() {
  const has = !!me.name;
  $("me-input").hidden = has;
  $("btn-join").hidden = has;
  $("btn-rename").hidden = !has;
  renderMe();
  if (has) refreshUser();
  else $("me-input").focus();
}
function joinAs() {
  const t = $("me-input").value.trim().slice(0, 24);
  if (!t || t.startsWith("🤖")) return;
  me.name = t;
  localStorage.setItem("cx-name", t);
  ensureName();
}
$("btn-join").onclick = joinAs;
$("me-input").addEventListener("keydown", (e) => { if (e.key === "Enter") joinAs(); });
$("btn-rename").onclick = () => {
  me.name = ""; me.user = null; me.balance = null;
  localStorage.removeItem("cx-name");
  renderPortfolio();
  ensureName();
};

async function refreshUser() {
  if (!me.name) return;
  const u = await fetch(`/api/user?name=${encodeURIComponent(me.name)}`).then((r) => r.json());
  me.user = u;
  me.balance = u.balance;
  renderMe();
  renderPortfolio();
  if (detail.id) renderTicketPosition();
}

function renderMe() {
  $("me-name").textContent = me.name || "";
  $("me-balance").innerHTML = me.balance == null ? ""
    : `${fmt(me.balance)} <span class="unit">chips</span>`;
}

// ---- LMSR quoting (mirror of server math) --------------------------------
function lse(xs) { const m = Math.max(...xs); return m + Math.log(xs.reduce((s, x) => s + Math.exp(x - m), 0)); }
function quoteBuy(m, oi, spend) {
  const { q, b } = m;
  const l = lse(q.map((x) => x / b));
  const others = q.reduce((s, x, j) => (j === oi ? s : s + Math.exp(x / b - l)), 0);
  const v = Math.exp(spend / b) - others;
  if (v <= 0) return null;
  return b * (Math.log(v) + l) - q[oi];
}
function quoteSell(m, oi, shares) {
  const { q, b } = m;
  const q2 = q.slice();
  q2[oi] -= shares;
  return b * lse(q.map((x) => x / b)) - b * lse(q2.map((x) => x / b));
}

// ---- shared board rendering ---------------------------------------------
function boardHTML(fen) {
  const rows = fen.split(" ")[0].split("/");
  let html = "";
  rows.forEach((row, r) => {
    let file = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) {
        for (let k = 0; k < +ch; k++) { html += sqHTML(r, file, null); file++; }
      } else { html += sqHTML(r, file, ch); file++; }
    }
  });
  return html;
}
function sqHTML(r, f, piece) {
  const light = (r + f) % 2 === 0;
  let inner = "";
  if (piece) {
    const isWhite = piece === piece.toUpperCase();
    inner = `<span class="${isWhite ? "wp" : "bp"}">${GLYPH[piece.toLowerCase()] || ""}</span>`;
  }
  return `<div class="sq ${light ? "l" : "d"}">${inner}</div>`;
}
function clockFmt(s) {
  if (s == null) return "–:––";
  s = Math.max(0, s);
  const m = Math.floor(s / 60), sec = s % 60;
  return `${m}:${String(Math.floor(sec)).padStart(2, "0")}`;
}

// ---- rails ---------------------------------------------------------------
const RAILS = [
  { id: "boards", title: "Live boards", hero: true },
  { id: "replays", title: "Replays" },
  { id: "blind", title: "Odds only", collapsible: true, defaultCollapsed: true },
  { id: "done", title: "Recently resolved", collapsible: true, defaultCollapsed: true },
];

function collapsedKey(id) { return "cx-collapsed-" + id; }

function groupOf(m) {
  if (m.status !== "open") return "done";
  if (m.board && m.kind !== "replay") return "boards";
  if (m.kind === "replay") return "replays";
  return "blind";
}

const cardEls = new Map(); // marketId -> element
let railsBuilt = false;

function buildRails() {
  $("rails").innerHTML = RAILS.map((r) => `
    <section class="rail-sec" id="sec-${r.id}" hidden>
      <h2 class="rail-title ${r.collapsible ? "clickable" : ""}" data-sec="${r.id}">
        ${r.hero ? `<span class="live-pip"></span>` : ""}
        ${r.collapsible ? `<span class="chev">▾</span>` : ""}
        ${r.title} <span class="count" id="count-${r.id}"></span>
      </h2>
      <div class="rail" id="rail-${r.id}"></div>
    </section>`).join("");

  for (const r of RAILS) {
    const sec = $("sec-" + r.id);
    if (!r.collapsible) continue;
    const saved = localStorage.getItem(collapsedKey(r.id));
    const collapsed = saved === null ? !!r.defaultCollapsed : saved === "1";
    sec.classList.toggle("collapsed", collapsed);
    sec.querySelector(".rail-title").onclick = () => {
      const now = sec.classList.toggle("collapsed");
      localStorage.setItem(collapsedKey(r.id), now ? "1" : "0");
    };
  }
  railsBuilt = true;
}

function badge(m) {
  if (m.status === "resolved") return `<span class="badge">Final</span>`;
  if (m.status === "void") return `<span class="badge void">Void</span>`;
  if (m.kind === "replay") return `<span class="badge replay">Replay</span>`;
  return `<span class="badge live">Live</span>`;
}

// Display helpers: bots get a quiet chip rather than an emoji.
function traderName(name, isBot) {
  return esc(name) + (isBot ? `<span class="bot-chip">BOT</span>` : "");
}
function shares(n) { return (Math.round(n * 10) / 10).toLocaleString(); }

function playerLine(p, clock, low) {
  const name = p ? `${p.title ? p.title + " " : ""}${p.username}` : "?";
  const rating = p?.rating ? ` ${p.rating}` : "";
  return `<b>${esc(name)}<span class="meta">${esc(rating)}</span></b>` +
    `<span class="clk ${low ? "low" : ""}">${clockFmt(clock)}</span>`;
}

function cardHTML(m) {
  const p = m.prices;
  const win = m.winner;
  const b = m.board;
  const lowW = b?.clocks?.white != null && b.clocks.white < 20;
  const lowB = b?.clocks?.black != null && b.clocks.black < 20;
  const boardFen = b?.fen || START_FEN;
  const locked = !b;
  return `
    <div class="who">${playerLine(m.meta.black, b?.clocks?.black, lowB)} ${badge(m)}</div>
    <div class="mini-board ${locked ? "dim" : ""}" data-board>
      ${boardHTML(boardFen)}
      ${locked ? `<div class="board-lock"><span>No public board feed</span></div>` : ""}
    </div>
    <div class="who">${playerLine(m.meta.white, b?.clocks?.white, lowW)}</div>
    <div class="prices">
      ${OUTCOMES.map((o, i) => `
        <div class="price ${OUT_CLASS[o]} ${win === o ? "win" : ""}">
          ${Math.round(p[i] * 100)}¢<small>${OUT_LABEL[o]}</small>
        </div>`).join("")}
    </div>
    <div class="foot">
      <span>${esc(m.subtitle)}</span>
      <span>${b ? "Move " + Math.ceil(b.ply / 2) : ""}</span>
    </div>`;
}

// Compact row for secondary sections (no board preview).
function compactHTML(m) {
  const p = m.prices;
  const win = m.winner;
  return `
    <div class="c-main">
      <span class="c-title">${esc(m.title)}</span>
      <span class="c-sub">${esc(m.subtitle)}</span>
    </div>
    <div class="c-prices">
      ${OUTCOMES.map((o, i) => `
        <span class="cp ${OUT_CLASS[o]} ${win === o ? "win" : ""}"
              title="${OUT_LABEL[o]}">${Math.round(p[i] * 100)}¢</span>`).join("")}
    </div>
    ${badge(m)}`;
}

const COMPACT_RAILS = new Set(["blind", "done"]);

function renderMarkets() {
  if (!railsBuilt) buildRails();
  const groups = { boards: [], replays: [], blind: [], done: [] };
  for (const m of state.markets) groups[groupOf(m)].push(m);
  groups.done = groups.done.slice(0, 10);

  for (const railId of Object.keys(groups)) {
    const rail = $("rail-" + railId);
    const sec = $("sec-" + railId);
    const list = groups[railId];
    const compact = COMPACT_RAILS.has(railId);
    rail.classList.toggle("compact", compact);
    sec.hidden = list.length === 0;
    const want = new Set(list.map((m) => m.id));
    for (const el of [...rail.children]) {
      if (!want.has(el.dataset.id)) { cardEls.delete(el.dataset.id); el.remove(); }
    }
    list.forEach((m, i) => {
      let el = cardEls.get(m.id);
      if (!el || el.parentElement !== rail) {
        el?.remove();
        el = document.createElement("div");
        el.dataset.id = m.id;
        el.onclick = () => openDetail(m.id);
        cardEls.set(m.id, el);
      }
      el.className = compact ? "ccard" : "bcard";
      el.innerHTML = compact ? compactHTML(m) : cardHTML(m);
      const ref = rail.children[i];
      if (ref !== el) rail.insertBefore(el, ref || null);
    });
    $("count-" + railId).textContent = list.length;
  }
}

// Cheap in-place board refresh on move events (no full re-render).
function refreshCardBoard(m) {
  const el = cardEls.get(m.id);
  if (!el || !m.board) return;
  if (groupOf(m) !== el.parentElement?.id.replace("rail-", "")) {
    renderMarkets(); // moved rails (e.g. first board data arrived)
    return;
  }
  const bd = el.querySelector("[data-board]");
  if (bd) bd.innerHTML = boardHTML(m.board.fen);
  const whos = el.querySelectorAll(".who");
  if (whos.length === 2) {
    const lowB = m.board.clocks?.black != null && m.board.clocks.black < 20;
    const lowW = m.board.clocks?.white != null && m.board.clocks.white < 20;
    whos[0].innerHTML = `${playerLine(m.meta.black, m.board.clocks?.black, lowB)} ${badge(m)}`;
    whos[1].innerHTML = playerLine(m.meta.white, m.board.clocks?.white, lowW);
  }
  const foot = el.querySelector(".foot span:last-child");
  if (foot) foot.textContent = "Move " + Math.ceil(m.board.ply / 2);
}

function renderLeaderboard() {
  $("leaderboard").innerHTML = state.leaderboard.slice(0, 10).map((a) =>
    `<li class="${a.name === me.name ? "me-row" : ""}">` +
    `<span class="who">${traderName(a.name, a.isBot)}</span>` +
    `<span class="eq pnl ${a.pnl >= 0 ? "up" : "down"}">${a.pnl >= 0 ? "+" : ""}${fmt(a.pnl)}</span></li>`).join("");
}

function renderTape() {
  $("tape").innerHTML = state.trades.slice(-40).reverse().map(tapeLine).join("");
}
function tapeLine(t) {
  const m = state.markets.find((x) => x.id === t.marketId);
  const price = Math.round((t.chips / t.shares) * 100);
  return `<div class="t-row">
    <div class="t-head">${traderName(t.user, t.isBot)}
      <span class="amt">${t.side === "buy" ? "bought" : "sold"} ${shares(t.shares)} ${OUT_LABEL[t.outcome]} at ${price}¢</span></div>
    <div class="t-sub">${esc(m ? m.title : t.marketId)}</div>
  </div>`;
}

function renderPortfolio() {
  const u = me.user;
  if (!u) {
    $("portfolio").innerHTML = `<div class="empty">Join to start trading.</div>`;
    return;
  }
  const rows = u.positions.filter((p) => p.value > 0.01);
  const list = rows.length ? rows.map((p) => `
    <div class="pos">
      <span class="t">${esc(p.title)}</span>
      <span class="v">${OUTCOMES.filter((o) => p.shares[o] > 0.01)
        .map((o) => `${shares(p.shares[o])} ${OUT_LABEL[o]}`).join(" · ")} · ${fmt(p.value)} chips</span>
    </div>`).join("") : `<div class="empty">No open positions.</div>`;
  $("portfolio").innerHTML = list +
    `<div class="row"><span class="name">Realized P&L</span>` +
    `<span class="pnl ${u.realized >= 0 ? "up" : "down"}">${u.realized >= 0 ? "+" : ""}${fmt(u.realized)}</span></div>`;
}

// ---- detail --------------------------------------------------------------
function openDetail(id) {
  detail.id = id;
  $("detail").hidden = false;
  setSide("buy");
  renderDetail();
}
$("detail-close").onclick = () => { $("detail").hidden = true; detail.id = null; };
$("detail").onclick = (e) => { if (e.target === $("detail")) $("detail-close").onclick(); };

function m$() { return state.markets.find((x) => x.id === detail.id); }

function renderDetail() {
  const m = m$();
  if (!m) return;
  $("d-title").textContent = m.title;
  $("d-sub").textContent = m.subtitle;
  $("d-badge").innerHTML = badge(m);

  let banner = document.querySelector(".result-banner");
  banner?.remove();
  if (m.status !== "open") {
    const div = document.createElement("div");
    div.className = "result-banner";
    div.textContent = m.status === "void"
      ? (m.meta.resultText || "Voided")
      : `${OUT_LABEL[m.winner]} wins${m.meta.resultText ? " — " + m.meta.resultText : ""}`;
    $("d-title").after(div);
  }

  drawChart(m);
  renderBoard(m);
  renderOutcomeButtons(m);
  renderQuote();
  renderTicketPosition();
  renderMarketTrades(m);
  $("d-submit").disabled = m.status !== "open";
}

function renderBoard(m) {
  const wrap = $("d-board-wrap");
  const note = $("d-live-note");
  if (m.board) {
    wrap.hidden = false; note.hidden = true;
    $("d-board").innerHTML = boardHTML(m.board.fen);
    $("d-clock-w").textContent = "♙ " + clockFmt(m.board.clocks.white);
    $("d-clock-b").textContent = "♟ " + clockFmt(m.board.clocks.black);
    $("d-moves").textContent = (m.board.labels || []).join(" ");
  } else {
    wrap.hidden = true;
    note.hidden = m.kind !== "live";
    $("d-link").href = m.meta.gameUrl || "#";
  }
}

function renderOutcomeButtons(m) {
  $("d-outcomes").innerHTML = OUTCOMES.map((o, i) => `
    <button class="${o} ${detail.outcome === o ? "sel" : ""}" data-o="${o}">
      ${Math.round(m.prices[i] * 100)}¢<small>${OUT_LABEL[o]}</small>
    </button>`).join("");
  $("d-outcomes").querySelectorAll("button").forEach((b) => {
    b.onclick = () => { detail.outcome = b.dataset.o; renderOutcomeButtons(m); renderQuote(); };
  });
}

$("d-buy").onclick = () => setSide("buy");
$("d-sell").onclick = () => setSide("sell");
function setSide(s) {
  detail.side = s;
  $("d-buy").classList.toggle("on", s === "buy");
  $("d-sell").classList.toggle("on", s === "sell");
  $("d-submit").textContent = s === "buy" ? "Buy" : "Sell";
  $("d-submit").classList.toggle("sell", s === "sell");
  renderQuote();
}
$("d-amount").oninput = renderQuote;

function renderQuote() {
  const m = m$();
  if (!m) return;
  const amt = parseFloat($("d-amount").value);
  const oi = OUTCOMES.indexOf(detail.outcome);
  if (!(amt > 0)) { $("d-quote").textContent = ""; return; }
  if (detail.side === "buy") {
    const sh = quoteBuy(m, oi, amt);
    $("d-quote").textContent = sh
      ? `${amt} chips buys about ${sh.toFixed(1)} ${OUT_LABEL[detail.outcome]} shares at ${Math.round((amt / sh) * 100)}¢ average. Pays ${sh.toFixed(1)} chips if ${OUT_LABEL[detail.outcome]} wins.`
      : "Amount too small.";
  } else {
    const pr = quoteSell(m, oi, amt);
    $("d-quote").textContent = `Selling ${amt} shares returns about ${pr.toFixed(1)} chips.`;
  }
}

function renderTicketPosition() {
  const pos = me.user?.positions.find((p) => p.marketId === detail.id);
  $("d-pos").textContent = pos
    ? "You hold " + OUTCOMES.filter((o) => pos.shares[o] > 0.01)
        .map((o) => `${shares(pos.shares[o])} ${OUT_LABEL[o]}`).join(", ")
    : "";
}

$("d-submit").onclick = async () => {
  if (!me.name) { ensureName(); if (!me.name) return; }
  const amt = parseFloat($("d-amount").value);
  $("d-error").textContent = "";
  try {
    const res = await fetch("/api/trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user: me.name, marketId: detail.id, outcome: detail.outcome,
        side: detail.side, amount: amt,
      }),
    }).then((r) => r.json());
    if (res.error) throw new Error(res.error);
    me.user = res.user;
    me.balance = res.user.balance;
    renderMe(); renderPortfolio(); renderTicketPosition();
  } catch (e) {
    $("d-error").textContent = e.message;
  }
};

function renderMarketTrades(m) {
  const trades = state.trades.filter((t) => t.marketId === m.id).slice(-20).reverse();
  $("d-trades").innerHTML = trades.map((t) =>
    `<div>${traderName(t.user, t.isBot)} ${t.side === "buy" ? "bought" : "sold"} ` +
    `${shares(t.shares)} ${OUT_LABEL[t.outcome]} at ${Math.round((t.chips / t.shares) * 100)}¢</div>`
  ).join("") || `<div>No trades yet.</div>`;
}

function drawChart(m) {
  const cv = $("d-chart");
  const ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, cv.width, cv.height);
  const h = m.history;
  if (!h || h.length < 2) return;
  const pad = 24;
  ctx.strokeStyle = "#242e3d"; ctx.fillStyle = "#5b6675"; ctx.font = "10px sans-serif";
  for (const yv of [0, 0.25, 0.5, 0.75, 1]) {
    const y = pad / 2 + (1 - yv) * (cv.height - pad);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cv.width, y); ctx.stroke();
    ctx.fillText(Math.round(yv * 100) + "¢", 4, y - 3);
  }
  OUTCOMES.forEach((o, oi) => {
    ctx.beginPath();
    ctx.strokeStyle = COLORS[o];
    ctx.lineWidth = 2;
    h.forEach((pt, i) => {
      const x = (i / (h.length - 1)) * cv.width;
      const y = pad / 2 + (1 - pt.p[oi]) * (cv.height - pad);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  });
}

// ---- live updates --------------------------------------------------------
const es = new EventSource("/api/stream");
es.addEventListener("snapshot", (e) => {
  state = JSON.parse(e.data);
  renderMarkets(); renderLeaderboard(); renderTape();
  if (detail.id) renderDetail();
  if (me.name) refreshUserThrottled();
});
es.addEventListener("board", (e) => {
  const { marketId, board } = JSON.parse(e.data);
  const m = state.markets.find((x) => x.id === marketId);
  if (!m) return;
  m.board = board;
  refreshCardBoard(m);
  if (detail.id === marketId) renderBoard(m);
});
es.addEventListener("trade", (e) => {
  const t = JSON.parse(e.data);
  state.trades.push(t);
  const m = state.markets.find((x) => x.id === t.marketId);
  if (m) { m.prices = t.prices; m.history.push({ t: t.t, p: t.prices }); }
});
es.addEventListener("resolve", (e) => {
  const upd = JSON.parse(e.data);
  const i = state.markets.findIndex((x) => x.id === upd.id);
  if (i >= 0) state.markets[i] = upd; else state.markets.unshift(upd);
  renderMarkets();
  if (detail.id === upd.id) renderDetail();
  if (me.name) refreshUser();
});

let userTimer = null;
function refreshUserThrottled() {
  if (userTimer) return;
  userTimer = setTimeout(() => { userTimer = null; refreshUser(); }, 4000);
}

function fmt(x) { return (Math.round(x * 100) / 100).toLocaleString(); }
function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

ensureName();
