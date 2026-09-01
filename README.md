# ♞ Chess Exchange

A play-money prediction market on **real chess.com games** — Polymarket-style prices,
live game feeds, an automated market maker, and liquidity bots. An experiment; not
affiliated with chess.com, and no real money anywhere.

```bash
npm start        # → http://localhost:4600
```

Zero dependencies (Node 18+; built on Node 26).

## Try the engine without `npm start`

Strangers can paste a FEN and see White / Draw / Black on a static GitHub
Pages demo. It uses a browser-safe copy of the in-process alpha-beta in
`lib/engine.js` (`docs/engine.js` must stay identical). Elo is only the
no-board fallback.

`docs/` is deployed by GitHub Actions (`.github/workflows/pages.yml`):
`actions/upload-pages-artifact` then `actions/deploy-pages`. Agents do
not turn Pages on, and they do not touch `Charliewytk.github.io`. If the
project site 404s, one click (or a later Pages click) is enough:

1. Open this repo on GitHub → **Settings → Pages**
2. **Source:** GitHub Actions
3. Save. If the first run failed before Pages was enabled, re-run
   **Deploy Pages demo** from the Actions tab (or push to `main` again).

The site will be `https://charliewytk.github.io/chess-exchange/`.

Local check (any static file server; not `npm start`):

```bash
python3 -m http.server 8080 --directory docs
# → http://localhost:8080
```

### Later: a £5 Gumroad link (Charles clicks payments)

The demo is free to try. If you later want a paid note on that page, paste
an **existing** Gumroad URL into the `GUMROAD` comment in `docs/index.html`.
Do not invent a new SKU. You still click checkout yourself. Agents never
buy or post. There is no live P&L on this page.

## What you get

- **LIVE BOARD markets (lichess TV)** — lichess's public streaming API serves its
  featured bullet/blitz/rapid games move-by-move (FEN + clocks, no auth). These
  markets have a real-time board, live clocks, and prices from an engine eval
  of the current position (Elo is only used if there is no FEN). This is the
  full "bet while you watch" experience, working out of the box.
- **LIVE markets (chess.com)** — the app polls chess.com's public top-games roster
  (`service/gamelist/top`, ~every 3.5s). When titled players (GM/IM/FM…) start a
  blitz or bullet game, a market opens with White/Draw/Black outcome shares priced
  from an Elo + draw-rate prior (no live board, so no engine eval yet). When the
  real game ends, the official result
  (`callback/live/game/{id}`) resolves the market: winning shares pay 100¢.
- **REPLAY markets** — chess.com doesn't expose move-by-move data to anonymous
  clients (the live websocket requires a logged-in session), but the moment a game
  finishes it returns the full move list (TCN-encoded) *plus per-move clock
  timestamps*. Just-finished games are rebroadcast move-by-move at true clock
  speed with a live board, and the market resolves at the final position. Bots
  trade toward the engine eval of the current FEN, so prices swing on
  blunders like the real thing.
- **chess.com live boards, two ways (optional)**:
  1. **Browser extension (recommended)** — load `extension/` as an unpacked
     extension in Brave/Chrome (`brave://extensions` → Developer mode → Load
     unpacked). Browse chess.com logged in as yourself; when you open a live
     game that has a market, the extension relays the board to the exchange
     (everyone sees it live) and overlays the current W/D/B odds on the
     chess.com page itself.
  2. **Headless bridge** — run `npm run login`: a visible browser window opens
     on a dedicated profile; log in to chess.com yourself and close the window
     (the app never sees or stores credentials). Restart the server and
     `lib/bridge.js` (a zero-dep CDP driver for your installed Brave/Chrome)
     watches up to 3 live games headlessly with no tabs to babysit.
- **LMSR market maker** — every market uses a logarithmic market scoring rule
  (b = 300), so there's always a price to trade against and prices are
  probabilities. Buy with chips, sell shares back any time.
- **Bots** — six liquidity bots with different aggression/noise/trust profiles
  trade toward their beliefs: engine WDL (win/draw/loss) whenever a FEN exists
  (lichess TV, replays, bridged live boards), and the Elo prior only when there
  is no position to evaluate. They never see the stored result of a replay.
- **Accounts** — pick a name, get 1000 chips. Balances persist across restarts
  (`data/state.json`). Leaderboard ranks by equity (chips + mark-to-market
  positions).

## Architecture

```
server.js          HTTP + SSE hub + persistence (no frameworks)
lib/feed.js        chess.com polling: roster → live markets, resolution
                   polling, replay scheduler (true-speed rebroadcast)
lib/lichess.js     lichess TV ndjson streams → live-board markets + resolution
lib/cdp.js         minimal Chrome DevTools Protocol client (built-in WebSocket)
lib/bridge.js      headless-Brave bridge for chess.com live boards (needs the
                   one-time `npm run login`)
lib/market.js      LMSR exchange: accounts, buy/sell, resolve/void
lib/bots.js        liquidity bots
lib/engine.js      compact alpha-beta eval → White/Draw/Black WDL (FEN prior)
lib/tcn.js         decoder for chess.com's 2-chars-per-move TCN encoding
lib/board.js       minimal board tracker (castling/EP/promotion aware) → FEN
public/            vanilla JS frontend: board-first horizontal rails, detail
                   modal with chart + trade ticket, SSE live updates
extension/         MV3 browser extension: relays live boards from chess.com
                   pages you watch (main-world reader → service worker →
                   POST /api/bridge/board) and overlays exchange odds
```

Notes / findings from the reverse-engineering session:

- `https://www.chess.com/service/gamelist/top` — public JSON roster of the top
  ~40 live titled games (players, ratings, time control, game UUIDs + legacy IDs).
- `https://www.chess.com/callback/live/game/{legacyId}` — 404 while the game is
  live, full game JSON (result, TCN moves, clock per move) once finished.
- The live cometd websocket (`wss://live.chess.com/cometd`) rejects anonymous
  handshakes (`authentication-failed`; with `clientFeatures.protocolversion: "2.1"`
  it gets further, but a logged-in session cookie is required). Guests on the
  website use a newer RSocket transport (`prod.chess-platform.com`), also authed.
- Guest visits to `/game/live/{id}` redirect to `/play/online` — no scraping path
  without login.

Polling is deliberately gentle (roster every 3.5s, one resolution check per 6s).

## Market lifecycle

open → (game leaves roster: still open, "finishing…") → resolved (official result)
                                                      → void after 45 min without a
                                                        result (stakes refunded)

If a market is voided, everyone gets back exactly their net spend.

## Known limitations / ideas

- chess.com LIVE markets have no board until you do the one-time `npm run login`
  (see above); lichess TV markets always have live boards.
- The bridge's logged-in path is untested until a real login exists — expect to
  tweak the clock selectors in `lib/bridge.js` on first run.
- Replays are delayed broadcasts: if you watched the live market resolve, you
  know the replay's result — farming bots is possible. It's play money; be kind.
- Draw (and win) pricing uses a real engine eval of the current FEN whenever a
  board exists; the Elo + draw-rate prior is only the no-board fallback
  (chess.com LIVE markets until a FEN arrives via the extension or bridge).
- One process, in-memory markets: restart voids nothing but forgets open markets
  (accounts survive; open-market stakes are effectively released).
