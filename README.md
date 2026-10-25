# ForexTester

Personal strategy research using CME **6E Euro FX futures** trade prices from Databento. New backtests use `GLBX.MDP3`, `ohlcv-1m`, `6E.v.0`, input symbology `continuous`. The app keeps the Setup → Trading → Results workflow, one to three independently navigable charts with synchronized free crosshairs, indicators, manual replay, two independent positions, journal, statistics and durable local sessions.

These are simplified research fills with hypothetical forex-style sizing applied to futures-derived prices. They do not represent accurate EUR/USD CFD execution or exchange-accurate futures contracts.

## Run locally

Use Node.js 24 and npm 11 or newer.

```sh
npm ci
npm run dev:backend
# Another terminal:
npm run dev:frontend
```

Vite prints the frontend URL. The backend binds to `127.0.0.1:3001` by default. Set `PORT` to override it. Build with `npm run build`; run the compiled backend with `npm start --workspace backend`.

## Databento credentials and spending

Keep `DATABENTO_API_KEY` in the **backend environment only**. Never use a `VITE_` variable or enter credentials into the browser. Copy `.env.example` to `.env` in the project root and fill in your private backend configuration:

```sh
cp .env.example .env
npm run dev:backend
```

On Node.js 24, backend startup automatically loads the project-root `.env` using the built-in `process.loadEnvFile()` support. This works in development and with the compiled backend (`npm start --workspace backend`), regardless of the launch directory. Variables explicitly provided to the process take precedence, including an explicitly empty value. A missing `.env` is allowed; other file-access errors stop startup rather than silently ignoring configuration problems.

Only backend startup loads this file. The frontend does not load the project-root `.env`, and the API key is never included in frontend configuration or browser assets. `.env` and `.env.*` remain ignored by Git; `.env.example` is a credential-free template. Do not commit private configuration. An existing private environment file can still be exported by the launching shell; those exported values override the project-root file.

A missing key prevents live metadata and new downloads. Validated cached history remains available without a key or credit verification. Access failures never print upstream bodies, headers, keys or stack traces. HTTP redirects are refused. No browser installation, brokerage application or manual CSV download is required for history.

Before approving a new download, verify the current usable credit balance and validity in the Databento portal. Set these backend variables from that evidence:

- `DATABENTO_CREDITS_USD`: currently usable credits, not an assumed starting balance.
- `DATABENTO_CREDITS_VERIFIED_AT`: ISO UTC time checked, within the last 24 hours.
- `DATABENTO_CREDITS_EXPIRE_AT`: verified ISO UTC expiry, more than 15 minutes away.
- `DATABENTO_TEST_BUDGET_USD`: defaults to **$5** and cannot exceed $5 in this implementation.

The project lead reported $121.35 and separately confirmed validity for the two initial verification downloads. This is recorded as scoped approval for those exact ranges in the verification evidence. The actual expiry date remains unknown and is not an application default.

Choose **From / Through** inclusive UTC dates, up to **90 calendar days**. Loading includes **30 earlier calendar days** for indicators. Select **Load historical data** to inspect the cache and obtain the quote. A fully cached interval loads without spending. A partially cached or uncached interval opens a dedicated Setup dialog showing calendar-date coverage, missing ranges, new cost, the internal reservation, remaining budget, expiry and blockers. Approval stays disabled until you acknowledge that actual billing can differ. **Cancel — No download** returns to Setup without a paid request or reservation; **Approve paid download — Estimated $X** submits the quoted missing ranges once.

Local cache bounds are separate from provider availability. When provider availability is unverified, Setup shows no earliest advertised date and does not impose a cache-derived minimum. Earlier completed periods can be selected under the same 90-day rule; uncached dates require Databento access for metadata verification, missing-date estimates and explicit approval. Fully cached periods still load offline.

Quotes expire after five minutes. Before downloading, the backend rechecks costs, contract mappings, credit evidence and budget. Any cost increase, mapping change or changed uncached interval requires a fresh quote and approval. The backend reserves **twice the estimate** against the $5 budget as contingency. This is still an estimate, **not a Databento-enforced billing ceiling**. Actual billing cannot be guaranteed by `metadata.get_cost`.

The persistent `verification-budget.json` includes successful and uncertain requests. Interrupted, failed or invalid downloads retain their reservation. Paid requests are never retried automatically. A process-wide filesystem lock prevents overlapping paid work; a lock left by a crash requires manual review of account usage and the ledger before removal. Restarting does not reset the allowance. Never remove the ledger or change the cache directory to evade the cumulative budget.

Startup, refresh, session restoration and background work issue no paid requests. Metadata calls are free. A cancelled browser request can leave an already-approved backend download running; wait for it to finish, then re-quote to check its cache rather than resubmitting.

The implementation follows Databento's [Historical API](https://databento.com/docs/api-historical), [symbology conventions](https://databento.com/docs/standards-and-conventions/symbology) and [billing guide](https://databento.com/docs/portal/billing). Metadata and symbology are free; historical streaming requests are metered, including repeated downloads.

## Data, gaps and contract rollover

The backend calls `metadata.get_dataset_range`, `symbology.resolve`, `metadata.get_cost` and, only after confirmation, `timeseries.get_range`. Downloads are bounded newline-delimited JSON with scaled decimal prices, ISO UTC timestamps and exact uint64 volume strings. Validation requires M1 alignment, increasing unique timestamps, finite positive coherent OHLC, correct schema/publisher/instrument and complete verified raw-contract mappings. A malformed, truncated or conflicting stream never becomes ready.

Every bar retains its original OHLC and actual instrument ID. There is no synthetic spread, interpolation, forward fill, tick reconstruction or automatic back adjustment. Databento omits intervals without trades. Gap counts include no-trade intervals and exchange closures; M1 OHLCV alone cannot prove which gaps represent missing source data.

M5, M15, H1 and H4 use the existing first-open, max-high, min-low, last-close aggregation on UTC boundaries. Separate contracts cannot share an aggregate candle. Charts and indicator warm-up begin within the chosen replay contract so a preceding rollover jump is not treated as an indicator input. Insufficient same-contract warm-up produces the existing warning.

**Replay stops before the first observation from another contract**, even when no position is open. Play and Next Candle cannot cross the boundary. Positions, pending orders, stops, equity and fees stay frozen at the final old-contract observation. Contract mappings and the block are visible in Trading. Finish to review results, or create another backtest with a replay start after the boundary.

A carry/close/reopen policy across rollover remains a project-lead product decision. This implementation does not invent rollover execution, carry positions across contracts or claim an uninterrupted trading workflow across rollover.

## Research execution and sizing

Both Buy and Sell entries fill at the next eligible observed M1 **open**. Manual closes use the next eligible M1 open and take precedence over its intrabar stop. Long stops use the eligible M1 low; short stops use its high. A gap through an existing stop fills at the adverse opening price. Entry bars can trigger a stop in that same M1 observation. A stop on the wrong side of the actual opening entry is rejected. No unavailable intrabar sequence is inferred.

There are two independently managed entry/position slots. Stops can be placed on any chart or entered with the keyboard and require confirmation. No automatic take profit, trailing stop, signal or broker integration is added.

Hypothetical forex-style sizing retains **1 lot = 100,000 EUR**, a pip convention of `0.0001`, and gross USD PnL = signed price difference × 100,000 × lots. Risk sizing uses the fixed configured reference balance and a combined gross planned-risk cap. This is not futures contract sizing. Gaps can exceed planned losses. Commission is configurable USD per hypothetical standard lot, split evenly between entry and exit; risk sizing excludes fees. No fabricated spread, margin, slippage beyond adverse gap-open handling, swaps or financing is modeled.

Indicators and higher timeframe candles use only the revealed M1 prefix. Replay supports paused single stepping and 1×/10×/100× batches. Charts offer M5, M15, H1, H4 and D1, start on H1, and retain legacy saved M1 selections. Each pane retains its own zoom, UTC range, replay-follow state and price scale. Wheel zoom anchors to the right edge. D1 aggregates only revealed M1 observations on UTC day boundaries; its Ichimoku preset reports incomplete warm-up until 78 daily candles are completed. The standard pre-roll and H4-based session start do not change. Paused replay permits dragging existing stops, with Modify SL and keyboard entry as alternatives. New entries automatically form one setup of up to two same-direction submissions; historical setup records retain their original grouping. Results preserve the distinction between realized journal statistics and account PnL including open equity. Finishing creates no forced exits.

## Durable sessions and legacy history

The local backend saves immutable validated histories, checkpoint revisions and incremental equity chunks to external files. Default storage: `$XDG_DATA_HOME/forextester/` when absolute, otherwise `~/.local/share/forextester/`. Override with `FOREXTESTER_DATA_DIR=/absolute/backtests`. The absolute location appears in session management. Browser clearing does not delete disk sessions.

Databento's validated daily cache lives at `$XDG_CACHE_HOME/forextester/databento/` when absolute, otherwise `~/.cache/forextester/databento/`. `FOREXTESTER_CACHE_DIR=/absolute/cache/root` selects `/absolute/cache/root/databento/`. Both roots must be outside the repository and must not overlap, including through symlinks. Actual source, symbol, dataset, schema, normalization version, contract identity and UTC boundaries participate in cache keys and new fingerprints. Checksums and full validation protect cached objects. Successful days are reused across overlapping intervals.

On this Linux installation, the verified December 2, 2023–March 31, 2024 cache (end exclusive) and original spending ledger were copied and validated into **`/home/admin/.cache/forextester/databento/`**. Normal `npm run dev:backend` launches discover them through the existing default. No cache environment override or credential file is needed for fully cached loads. Select **From 2024-01-01 / Through 2024-03-30** for the 90-day replay plus 30-day pre-roll. March 31 as an inclusive Through date would be 91 days in leap-year 2024.

The original `/home/admin/.cache/forextester-databento-verification-20261024/` remains an intact backup. Its ledger was preserved byte for byte: $0.805969089270 reserved, $4.194030910730 remaining. These are internal budget figures, not a current account balance or measured provider debit. No verification sessions were copied into user storage. Existing Dukascopy files and saved user histories were retained.

For another existing verified cache, a one-time offline import is available:

```sh
node --import tsx scripts/databento-cache-migrate.mts /absolute/source/databento
# Optional final argument: /absolute/destination/databento
```

It locks paid work in both directories, stages and verifies every copied file, validates all referenced days and the original ledger, then publishes without overwriting. Existing identical files are accepted; any conflicting or additional destination file stops the import. Unexpected source files, including sessions, are refused. The source remains intact. Never remove a crash lock or reset a ledger to force an import; review uncertain spending first. Custom cache locations still require the same `FOREXTESTER_CACHE_DIR` on every backend launch.


**Do not delete existing Dukascopy caches or user storage.** The application does not move, delete or mutate them. Existing EURUSD bid/ask datasets retain their original v1 fingerprint algorithm and execution rules. Valid stored sessions and older IndexedDB imports remain recoverable with their exact original history, checkpoint, journal and equity. New single-price datasets use a separate fingerprint format and cannot collide with legacy datasets.

Recovery reads the original dataset from disk or IndexedDB and resumes paused without re-executing orders or fees. Missing/corrupt **legacy history requires its original stored provider dataset**, recovered from backup while the backend is stopped. Databento cannot regenerate or substitute it. Legacy repair and migration never invoke a replacement provider. New Databento repair reads only the validated external cache and must match the saved fingerprint; if that exact history is unavailable, recovery stops.

Before switching sessions, the current backtest must save successfully. **Save now** retries pending writes. A storage error preserves current work in memory; keep the tab open until saving succeeds. Multiple tabs use revisions to reject stale writes. Autosaving batches edits around 150 ms and saves playback around every five seconds. A page close cannot guarantee the last asynchronous save completes.

Existing explicit rename, delete/tombstone, optional browser migration and storage-maintenance controls are retained. Cleanup requires preview and confirmation; only unreferenced known objects at least seven days old qualify. It never deletes active histories, migration receipts, unknown files, browser data or repository branches. Back up durable storage while the backend is stopped before maintenance.

## Verification

```sh
npm test -- --maxWorkers=2
npm run typecheck
npm run build
git diff --check
```

The complete deterministic suite covers API decoding, cost/credit gates, overlapping cache requests, persistent reservations, legacy fingerprints/recovery, single-price entries/stops/gaps/manual closes, indicators, UI behavior and full 120-day upload through the existing **64 MiB** history endpoint. Limiting workers avoids CPU-contention timeouts on long indicator fixtures.

Authenticated metadata and download evidence, real Chromium screenshots, measured sizes and current limitations are in [Databento verification](docs/databento/verification.md). Historical Task 20 evidence remains under `docs/task-20/` and records the previous provider implementation.

`scripts/databento-verify.mts` defaults to free quotes. Its optional paid path requires explicit confirmation flags, fresh scoped credit approval, unchanged approved estimates and the same persistent spending ledger. The initial authenticated datasets are already cached: **do not repeat paid requests for performance testing**.

`scripts/databento-browser.mts` uses the normal default cache and `npm run dev:backend` with isolated durable sessions under the Linux data directory, no credentials, and a provider-network tripwire. It checks charts, execution and refresh/restart restoration without provider traffic. Install verification-only `playwright-core` outside the repository if needed, and point `PLAYWRIGHT_MODULE` at its `index.mjs`; no browser dependency remains in application runtime. The authentic browser script honors `FOREXTESTER_CACHE_DIR`. `scripts/databento-confirmation-browser.mts` tests the paid dialog at 1440px and 1100px with mocked history responses only. Run either with `node --import tsx scripts/<name>.mts`; set `PLAYWRIGHT_MODULE` to the external Playwright module path.

TradingView Lightweight Charts attribution remains visible. See [third-party notices](THIRD_PARTY_NOTICES.md).

### Workspace display support

ForexTester supports desktop and smaller laptop browsers, verified in Chromium at 1440 × 1000 and 1100 × 800. The shell has a 1000px minimum width. Smartphone-specific layouts, stacked chart panes and phone-emulation checks have been intentionally removed; older screenshots under `docs/` are historical evidence, not current support claims.

Replay and chart-count controls live in the application header. Risk per entry, Buy/Sell and position management occupy the trading toolbar below it. The app-header info icon opens execution details and contract mappings; the UTC replay timestamp sits beside Account PnL. `EURUSD 6E` is the display label for 6E sessions; the underlying instrument, provider and legacy EURUSD sessions retain their identities.

Drag a chart left to create future-side margin. Replay-follow uses 12 bars or the larger indicator projection; manual margin is bounded to 40% of the visible logical span and at most 80 bars, allowing larger existing indicator projections. This is axis space, never unrevealed market data. Manual panning disengages replay-follow. Paused views remain where you leave them. On the next forward observation, an offscreen latest candle, or one within two bars of the right edge, restores follow mode for that pane while preserving zoom. Tight zoom limits the margin so the candle remains visible. Historical review uses its own revealed cutoff and does not trigger this recovery. Pan, zoom and saved views remain independent per pane. Indicator readiness is shown inside each Indicators dropdown.

Run the offline workspace verification with `PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs node --import tsx scripts/chart-toolbar-browser.mts`. It reads the existing cache, refuses all provider methods, uses isolated temporary sessions and writes screenshots plus measured layout/navigation evidence to `docs/topbar-tightening/`. See [verification](docs/topbar-tightening/verification.md).

During paused replay, Shift + Right completes one candle of the last chart you clicked, panned, scrolled, or changed timeframe on. Every intervening M1 observation still runs through execution. Shift + Left opens non-destructive historical review; it does not rewind trades. Trading is disabled until you step forward to current replay or select **Return to current replay**. New entries use **Risk per entry (%)**, initially 1%; historical manual-lot sessions remain readable. Execution details, Indicators, and optional idle Sessions / settings dismiss on outside clicks or Escape. See the [verification notes and browser evidence](docs/keyboard-replay-and-panel-ux/verification.md).

The header and auto-follow verification is in [replay header verification](docs/replay-header-and-auto-follow/verification.md). Run `PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs node --import tsx scripts/replay-header-browser.mts` against the existing cache. It uses temporary sessions, refuses provider methods and paid submissions, and measures the latest candle against the plot width excluding the price axis.

Draft stops show live pip distance from the current observed price while hovering and after selection. Drag a selected draft line to refine its price, then explicitly confirm with the toolbar or chart tick; release alone never submits. Missing quotes show **Distance unavailable**, and invalid sides are labeled. Risk, Buy, Sell, Slots and positions share one toolbar row. The position strip scrolls horizontally on smaller laptops; tab to actions or focus the strip and use arrow keys. Open the B1/B2 or S1/S2 details with Enter for full IDs and stop outcomes. See [live draft and inline toolbar verification](docs/live-draft-sl-and-inline-positions/verification.md).

## Results dashboard

Finished backtests open one vertically scrolling Results dashboard. The six primary metrics are account-equity net return, total setup net R, setup profit factor, maximum drawdown below initial capital, maximum drawdown from equity peak, and setup win rate. Equity defaults to percentage return with a USD toggle. Equity and drawdown share sampled M1 timestamps, UTC spacing, gaps and keyboard inspection. R bars represent complete setups in final-exit order, with deterministic setup-ID ties and 40-setup pages for larger samples. The monthly table shows every UTC month in the actual replay interval, including empty months, without pre-roll or unreplayed future months.

A completed setup is one trading decision, combining up to two executed positions. Setup net R divides combined position net PnL by combined original executed gross risk. Lot rounding and commissions remain reflected in those original records; stop changes never redefine the denominator. The normal 2% risk budget is combined across both entries. Total net R sums these setup results. Win rate includes exact breakevens in its denominator; profit factor divides positive setup net PnL by absolute negative setup net PnL. Profits without losses show ∞, losses without profits show 0, and no nonzero observations show N/A. Invalid original risk leaves aggregate R unavailable rather than showing a partial total.

Account return uses the latest M1 equity ledger, including incurred commissions and available unrealized PnL, divided by fixed initial capital. Maximum below-start drawdown measures the worst deficit relative to that initial capital. Peak drawdown uses the ledger's high-water marks, initially seeded with starting capital; nonpositive equity keeps peak percentage drawdown unavailable. All maxima use full observations, before chart downsampling. Missing valuations remain unavailable and break chart lines; market clock gaps also break lines.

Setup-based statistics, R bars, holding times and the secondary commission total include fully completed setups only. Monthly return is a **noncompounded realized contribution**: completed-setup net PnL attributed at final UTC exit, divided by fixed initial capital. It is not mark-to-market calendar-month return. A visible notice explains open, pending and partially completed setups. Finishing creates no exits, so account return can differ from completed-setup realized PnL. Secondary commissions cover completed setups, while all incurred entry fees remain in account equity.

The collapsed **Setup breakdown** retains individual position details, original risk, entries/exits, commissions, stop history, coverage warnings and read-only stored notes/tags. **Export trades** in the Results header uses the unchanged position CSV schema and spreadsheet-formula protection. **Save now** retains existing durable checkpoints. Legacy saved scope preferences remain compatible but do not drive Results calculations.

Verification, deterministic fixture details and screenshots: [Results dashboard report](docs/results-dashboard/verification.md). Reproduce the offline Chromium checks with `PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs node --import tsx scripts/results-dashboard-browser.mts`. This script creates temporary sessions and synthetic history, without reading the historical cache, instantiating a provider or touching user sessions.
