# ForexTester

Personal EURUSD Forex strategy research using an installed local Parquet archive
of mid-price M1 candles. Setup, Trading, Results, charts, indicators, two
independent positions, the journal, Balance & Equity, and durable sessions retain
the existing workflow. No API key, online data download, paid confirmation, or
broker connection is required.

## First-time setup (for someone cloning the project)

You need **the repository** and **a compatible EURUSD M1 Parquet file** supplied separately. The historical market data is **not** in Git, and you do not need any broker account, API key, database service, or Python installation.

### 1. Install prerequisites

- [Git](https://git-scm.com/downloads) to clone the project.
- **Node.js 24** with **npm 11 or newer**. Check in a terminal with `node --version` and `npm --version`. If missing, install the correct versions before continuing.
- Enough free disk space for **the original Parquet file plus a second managed copy** and generated caches.

The application is developed on Linux. If setting it up on Windows or macOS, verify that the native DuckDB dependency installs and the backend starts on that machine; these platforms are not promised to be tested.

### 2. Clone the repository and install dependencies

Open a terminal (or the terminal in VS Code) and run:

```sh
git clone https://github.com/OscarGR5/ForexTester.git
cd ForexTester
npm ci
```

Run all subsequent commands **from the `ForexTester` repository root** (the folder containing `package.json`). `npm ci` installs the exact locked frontend, backend, and tooling dependencies; do not run separate installs in the workspace folders.

### 3. Import your Parquet history (one time)

Keep the provided `.parquet` file **outside the repository**, e.g. in your Downloads folder. Import it by passing its **actual absolute path**:

```sh
# Linux example; replace this with your own path
node --import tsx scripts/import-local-forex.mts "/home/your-user/Downloads/eurusd_1min.parquet"
```

```powershell
# Windows PowerShell example; replace this with your own path
node --import tsx scripts/import-local-forex.mts "C:\Users\YourName\Downloads\eurusd_1min.parquet"
```

On macOS, use an absolute path such as `/Users/your-user/Downloads/eurusd_1min.parquet`. **Quotation marks matter** if the filename or folder names contain spaces.

The import validates the file, copies it into the app's persistent data directory, and prints a JSON summary including `symbol`, `rows`, and the available date range. A successful import reports `EURUSD` with a positive row count; errors need to be resolved before starting a backtest. The Parquet must match the supported EURUSD mid-price M1 OHLC schema. Importing the same file again is safe; importing a different EURUSD dataset over an existing one is intentionally blocked.

### 4. Run ForexTester

```sh
npm run dev
```

This starts the backend and frontend together. Open the **Local** URL printed by Vite in your terminal (normally `http://127.0.0.1:5173`). In the app's Setup screen, confirm that **EURUSD history is available**, choose an eligible date range, and load the backtest.

Leave the terminal running while using ForexTester. Press **Ctrl+C** there to stop both servers.

**For later use:** open a terminal in the cloned `ForexTester` directory and run only `npm run dev`. You do **not** need to reinstall dependencies or re-import the Parquet file each time, unless you have moved to another computer or deleted the installed data.

### Optional: give the setup to Codex

Open the cloned repository in VS Code with Codex and give it this prompt (also tell it the location of your Parquet file):

> Read README.md and package.json. Set up this ForexTester project on my computer so I can run it locally. I already have the EURUSD M1 Parquet file at `<PUT MY ABSOLUTE FILE PATH HERE>`. Check/install Git, Node.js 24, and npm 11 or newer as needed; run `npm ci`; use the existing importer to install my Parquet file outside Git; and start the app with `npm run dev`. Verify that the backend and frontend start and EURUSD history appears in Setup. Diagnose any errors instead of assuming success. Do not modify market data, saved sessions, trading behavior, or Git history. Do not commit the Parquet file, credentials, or other private local data. Report the exact URL to open and the command to use next time.

### Common setup problems

- **`node`, `npm`, or `git` not found:** install the relevant prerequisite and reopen the terminal.
- **File not found during import:** use an existing absolute file path, with quotes around it; avoid the example username/path verbatim.
- **`npm ci` fails:** check the Node/npm versions, installation logs, OS compatibility and network access. Do not immediately delete the lockfile or rewrite dependencies.
- **No EURUSD history in Setup:** check the import's JSON output and any backend errors. The app does not automatically download market data.
- **Wrong data or import conflict:** the app prevents silently replacing an installed dataset. Do not delete the persistent data directory to force an import, especially if saved sessions exist.
- **Frontend opens but requests fail:** keep `npm run dev` running, check that the backend starts on `127.0.0.1:3001`, and use the URL printed by Vite.

**Local data and privacy:** the managed market data, sessions, and settings live on the receiving computer. Cloning GitHub does not copy your existing backtests or private data. The local data location can be changed with `FOREXTESTER_DATA_DIR` in a project-root `.env` file; see `.env.example`. Keep it **outside the repository** and back it up separately.

## Data import and storage details

The importer loads project-root `.env` configuration, with process environment
variables taking precedence. `FOREXTESTER_DATA_DIR` selects a durable root outside
Git; the default is `$XDG_DATA_HOME/forextester` when absolute, otherwise
`~/.local/share/forextester`. The source file remains unchanged. The importer
checks permissions and disk capacity, copies into staging, verifies every row,
and publishes an immutable source plus checksum manifest. Repeating the same
import is safe; a different dataset for an installed symbol is rejected.

Managed data lives under `market-data/sources/EURUSD/<sha256>/source.parquet`,
`market-data/manifests/EURUSD.json`, and `market-data/cache/` inside that durable
root. Parquet files are excluded from Git. Additional pair registration accepts
an explicit instrument-metadata JSON argument; trading remains enabled only for
EURUSD because other quote currencies need approved USD conversion rules.

Vite prints the frontend URL; the API binds to `127.0.0.1:3001`. `npm run dev`
starts both servers and Ctrl+C stops both. Separate workspace dev commands remain
available. Build with `npm run build`; run the compiled backend with
`npm start --workspace backend`.

## History and execution

Setup discovers installed history and selects EURUSD automatically. Select 1–90
UTC calendar days with the 7-, 30-, and 90-day presets, timeline, or manual date
controls. Loading requests only the selected interval plus 30 earlier days for
indicators. The replay starts paused at the first observed eligible minute with
78 completed H4 observations. Source gaps, weekends and holidays remain gaps;
there is no forward fill or invented candle.

The supplied dataset covers March 9, 2005 at 14:35 UTC through September 25, 2026
at 20:59 UTC. The project lead confirmed mid OHLC and UTC Unix seconds labeling
the start of each minute. Because the first source day is partial, the earliest
selectable trading date with a full 30-day pre-roll is April 9, 2005.

Entries and manual exits fill at the next observed M1 open. Stops use the
observed high/low with gap-open handling. Both directions use the same mid-price
series. There is no spread, bid/ask synthesis, tick sequence, intrabar ordering,
slippage, swaps, or financing. EURUSD retains 1 standard lot = 100,000 EUR and USD
PnL, existing risk sizing, commissions, and two independent positions.

M1, M5, M15, H1, H4 and D1 analysis uses only revealed M1 observations. New Forex
sessions have no futures mapping or rollover boundary. Source identity, symbol,
mid-price execution model, normalization version, UTC range and all candles
participate in a distinct versioned local-Forex fingerprint.

## Durable sessions and legacy history

The original saved historical object remains authoritative. Dukascopy bid/ask
and Databento 6E sessions restore offline with their original fingerprints,
financial records, replay timestamps, execution semantics, and futures rollover
restrictions. Missing/corrupt legacy history requires its original saved object
from backup; it cannot be replaced by the Forex archive. Repair of new local
histories requires an exact fingerprint match against the installed source.

Do not delete existing provider caches, spending ledgers, `.env`, or saved
sessions. `archive/databento-2026-10-26` preserves the tracked main version at
`853500c84c1c536a12265787b2ece038dbce7504`, not excluded external data. The offline
`scripts/databento-cache-migrate.mts` tool remains available for copying original
legacy caches and their ledger without contacting a provider. Retired browser
scripts tied to the old provider workflow remain reproducible from that archive;
current browser verification uses `scripts/local-parquet-browser.mts`.

Before switching sessions, the current backtest must save successfully. **Save now** retries pending writes. A storage error preserves current work in memory; keep the tab open until saving succeeds. Multiple tabs use revisions to reject stale writes. Autosaving batches edits around 150 ms and saves playback around every five seconds. A page close cannot guarantee the last asynchronous save completes.

Existing explicit rename, delete/tombstone, optional browser migration and storage-maintenance controls are retained. Cleanup requires preview and confirmation; only unreferenced known objects at least seven days old qualify. It never deletes active histories, migration receipts, unknown files, browser data or repository branches. Back up durable storage while the backend is stopped before maintenance.

## Verification

```sh
npm test -- --maxWorkers=2
npm run typecheck
npm run build
git diff --check
```

The deterministic suite covers local import/query validation, interruption/conflict safety, legacy fingerprints/recovery, single-price entries/stops/gaps/manual closes, indicators, UI behavior and full 120-day upload through the existing **64 MiB** history endpoint. Limiting workers avoids CPU-contention timeouts on long indicator fixtures.

Current schema, import/query measurements and browser checks are in [the local Parquet migration report](docs/local-parquet-migration/implementation.md). Prior Databento evidence under `docs/databento/` describes the archived provider implementation.

Current schema, measurements and limitations are in the [local Parquet migration
report](docs/local-parquet-migration/implementation.md). To run browser checks:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs \
  node --import tsx scripts/local-parquet-browser.mts
```

The check uses the real installed archive and isolated temporary sessions at
1100px and 1440px, and rejects external requests. The old paid-provider checks
belong to `archive/databento-2026-10-26` and cannot be run against the new API.

TradingView Lightweight Charts attribution remains visible. See [third-party notices](THIRD_PARTY_NOTICES.md).

### Workspace display support

ForexTester supports desktop and smaller laptop browsers, verified in Chromium at 1440 × 1000 and 1100 × 800. The shell has a 1000px minimum width. Smartphone-specific layouts, stacked chart panes and phone-emulation checks have been intentionally removed; older screenshots under `docs/` are historical evidence, not current support claims.

Replay and chart-count controls live in the application header. Risk per entry, Buy/Sell and position management occupy the trading toolbar below it. The app-header info icon opens execution details and legacy-only contract mappings; the UTC replay timestamp sits beside Account PnL. `EURUSD 6E` is the display label for 6E sessions; the underlying instrument, provider and legacy EURUSD sessions retain their identities.

Drag a chart left to create future-side margin. Replay-follow uses 12 bars or the larger indicator projection; manual margin is bounded to 40% of the visible logical span and at most 80 bars, allowing larger existing indicator projections. This is axis space, never unrevealed market data. Manual panning disengages replay-follow. Paused views remain where you leave them. On the next forward observation, an offscreen latest candle, or one within two bars of the right edge, restores follow mode for that pane while preserving zoom. Tight zoom limits the margin so the candle remains visible. Historical review uses its own revealed cutoff and does not trigger this recovery. Pan, zoom and saved views remain independent per pane. Indicator readiness is shown inside each Indicators dropdown.

Current workspace checks use `scripts/local-parquet-browser.mts`. Historical chart-toolbar measurements remain in [verification](docs/topbar-tightening/verification.md).

During paused replay, Shift + Right completes one candle of the last chart you clicked, panned, scrolled, or changed timeframe on. Every intervening M1 observation still runs through execution. Shift + Left opens non-destructive historical review; it does not rewind trades. Trading is disabled until you step forward to current replay or select **Return to current replay**. New entries use **Risk per entry (%)**, initially 1%; historical manual-lot sessions remain readable. Execution details, Indicators, and optional idle Sessions / settings dismiss on outside clicks or Escape. See the [verification notes and browser evidence](docs/keyboard-replay-and-panel-ux/verification.md).

Enable **Regression** in the chart navigation bar, then Ctrl + Click a candle to anchor a shared M1 OHLC4 regression channel. The boundaries use ±2 standard errors of regression and at least three revealed M1 observations. All chart timeframes share the calculation. Ctrl + Click within 5 pixels of any channel line to delete the entire channel while the toggle stays enabled. Turning the toggle off retains the channel and disables deletion and repositioning. The anchor is saved with the session; historical review uses its displayed cutoff. See [implementation and verification](docs/regression-channel/verification.md).

Press **P** or use **Untaken Highs & Lows** in any Indicators dropdown to toggle rays across all charts. Red marks confirmed untaken local highs; green marks confirmed untaken local lows. A high requires a candle's wick high to exceed the immediately preceding high and a **closed** following candle to have a strictly lower high; lows use the opposite comparisons. Consecutive exactly equal highs/lows extend a plateau, anchored to its first candle, and require a strictly weaker preceding candle and a strictly weaker **closed** following candle. **No provisional or last-candle extremes are drawn**: the forming candle cannot confirm a local extreme, although its wick can invalidate an already confirmed level immediately. After confirmation, a later equal or crossing wick removes the ray, without drawing a new unconfirmed replacement. **Untaken Levels** is a positive integer, defaulting to 10: each chart displays up to 10 distinct untaken highs strictly above current price and 10 untaken lows strictly below it, nearest by price regardless of candle age. Hidden levels remain tracked. Rays start at the original pivot/plateau candle and sit behind candles without axis labels or autoscale contributions. Visibility and count are saved across backtests. Reproduce the isolated Chromium smoke check with `PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs node --import tsx scripts/untaken-levels-browser.mts`.

Historical header and auto-follow measurements remain in [replay header verification](docs/replay-header-and-auto-follow/verification.md). Its provider-based reproduction script belongs to the archive branch.

Draft stops show live pip distance from the current observed price while hovering and after selection. Drag a selected draft line to refine its price, then explicitly confirm with the toolbar or chart tick; release alone never submits. Missing quotes show **Distance unavailable**, and invalid sides are labeled. Risk, Buy, Sell, Slots and positions share one toolbar row. The position strip scrolls horizontally on smaller laptops; tab to actions or focus the strip and use arrow keys. Open the B1/B2 or S1/S2 details with Enter for full IDs and stop outcomes. See [live draft and inline toolbar verification](docs/live-draft-sl-and-inline-positions/verification.md).

## Results dashboard

Finished backtests open one vertically scrolling Results dashboard. The six primary metrics are account-equity net return, total setup net R, setup profit factor, maximum drawdown below initial capital, maximum drawdown from equity peak, and setup win rate. Balance & Equity displays ledger cash as a prominent teal step line and mark-to-market equity as a thinner lavender line. Both default to percentage return from fixed initial capital and switch together with the USD toggle. The legend lists Balance then Equity. The account and drawdown charts share sampled M1 timestamps, UTC spacing and keyboard inspection. R bars represent complete setups in final-exit order, with deterministic setup-ID ties and 40-setup pages for larger samples. The monthly table shows every UTC month in the actual replay interval, including empty months, without pre-roll or unreplayed future months.

A completed setup is one trading decision, combining up to two executed positions. Setup net R divides combined position net PnL by combined original executed gross risk. Lot rounding and commissions remain reflected in those original records; stop changes never redefine the denominator. The normal 2% risk budget is combined across both entries. Total net R sums these setup results. Win rate includes exact breakevens in its denominator; profit factor divides positive setup net PnL by absolute negative setup net PnL. Profits without losses show ∞, losses without profits show 0, and no nonzero observations show N/A. Invalid original risk leaves aggregate R unavailable rather than showing a partial total.

Account return uses the latest M1 equity ledger, including incurred commissions and available unrealized PnL, divided by fixed initial capital. Maximum below-start drawdown measures the worst deficit relative to that initial capital. Peak drawdown uses the ledger's high-water marks, initially seeded with starting capital; nonpositive equity keeps peak percentage drawdown unavailable. All maxima use full observations, before chart downsampling. Missing equity valuations remain unavailable and break the equity line. Dashed bridges join only actual valid endpoints across missing marks or clock gaps; they provide no intermediate valuations. Balance remains available when cash is known, including during missing equity marks. It changes only at recorded M1 entry-fee or realized exit executions. Downsampling retains every cash change and its preceding observation. Cash stays horizontal through open-position market closures when recorded executions confirm no intermediate transactions. Unknown cash intervals break the line; only equal endpoints get dashed cash bridges. Hover and keyboard readouts show a real UTC timestamp, Balance and Equity in USD and return %, and Floating PnL in USD. Missing Equity and Floating PnL show N/A.

Setup-based statistics, R bars, holding times and the secondary commission total include fully completed setups only. Monthly return is a **noncompounded realized contribution**: completed-setup net PnL attributed at final UTC exit, divided by fixed initial capital. It is not mark-to-market calendar-month return. A visible notice explains open, pending and partially completed setups. Finishing creates no exits, so account return can differ from completed-setup realized PnL. Secondary commissions cover completed setups, while all incurred entry fees remain in account equity.

The collapsed **Setup breakdown** retains individual position details, original risk, entries/exits, commissions, stop history, coverage warnings and read-only stored notes/tags. **Export trades** in the Results header uses the unchanged position CSV schema and spreadsheet-formula protection. **Save now** retains existing durable checkpoints. Legacy saved scope preferences remain compatible but do not drive Results calculations.

Verification, deterministic fixture details and screenshots: [Results dashboard report](docs/results-dashboard/verification.md). Reproduce the offline Chromium checks with `PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs node --import tsx scripts/results-dashboard-browser.mts`. This script creates temporary sessions and synthetic history, without reading the historical cache, instantiating a provider or touching user sessions.

Balance & Equity regression details, screenshots, production-bundle browser checks and limitations: [verification report](docs/balance-equity/verification.md). Reproduce with `PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs node --import tsx scripts/balance-equity-browser.mts`. The harness bundles the production Results dashboard with synthetic execution sessions and blocks all API/external requests.
