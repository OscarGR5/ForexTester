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

`scripts/databento-browser.mts` uses the normal default cache and `npm run dev:backend` with isolated durable sessions under the Linux data directory, no credentials, and a provider-network tripwire. It checks charts, execution and refresh/restart restoration without provider traffic. Install verification-only `playwright-core` outside the repository if needed, and point `PLAYWRIGHT_MODULE` at its `index.mjs`; no browser dependency remains in application runtime. The authentic browser script honors `FOREXTESTER_CACHE_DIR`. `scripts/databento-confirmation-browser.mts` tests the paid dialog at 1440px and 390px with mocked history responses only. Run either with `node --import tsx scripts/<name>.mts`; set `PLAYWRIGHT_MODULE` to the external Playwright module path.

TradingView Lightweight Charts attribution remains visible. See [third-party notices](THIRD_PARTY_NOTICES.md).
