# Trading chart UX verification

Branch: `feat/trading-chart-ux`, based on latest `origin/main` (`7dc4482`). No merge. All browser trading and persistence checks used a temporary session directory and an offline provider client. The original session directory was never opened. No dependencies were added.

## Behavior and implementation

Each chart owns a UTC range, logical span and replay-follow flag. Controlled wheel zoom fixes the right logical edge and clamps extreme spans to revealed observations plus permitted Ichimoku projection. Pointer position does not choose the anchor. Panning back disables follow, including when the viewport still contains the latest candle but has left the projection edge. Resizes restore the pane's saved range. Price scales remain independent.

Crosshairs use Normal mode. Remote price comes from the source pointer's pane and price conversion, with UTC bucket mapping to existing revealed observations. Missing target candles or oscillator panes clear the remote crosshair. Programmatic updates are guarded against feedback. Indicator last values, titles and crosshair markers are hidden; lines and clouds remain visible. Stop lines have a single axis price, with IDs in the dock and overlap chooser.

Existing open-position stops have a 7px vertical hit target while replay is paused and another executable candle exists. Coincident stops open a position-ID chooser: hold the selected button and drag vertically. Every chart displays the preview; the status line shows price, risk or validation error. Valid release calls the existing stop modification transition once. Escape, pointer cancellation, lost capture, window blur and lost trading permission cancel. Invalid releases restore the saved stop and show the engine's error. Modify SL and keyboard price entry remain available.

Production submissions use `requestAutomaticEntry`, which creates or joins the single active same-direction setup and counts submitted slots, including resolved requests while another entry remains active. The original execution and setup-assignment functions remain available for historical recovery and regression fixtures. Existing concurrent setups are retained, with further production submissions blocked until the conflict resolves. No PnL, commission, risk, stop timing or fill calculations changed.

## Cached Chromium workflow

The existing validated December 2, 2023 through March 30, 2024 cache supplied the 90-day preset. Start backtest opened paused at January 5, 2024, 16:00 UTC, retaining the existing H4 warm-up policy.

Actual Chromium mouse input verified right-anchored wheel zoom in both multi-chart layouts, independent horizontal pan, manual viewport retention after a replay tick, and H1/M5 pointer-price crosshairs across different price scales. Stop checks covered two coincident long stops selected by ID, independent modifications, Escape cancellation, invalid-release snapback, and a short stop in the next setup. During each drag, the durable trading stop remained unchanged until release. Each completed drag produced one history record with the current M1 timestamp, retaining the engine's effective-after-current-observation rule.

The journal rendered two completed setup rows with two and one executed positions. Their three closed trades retained their stop modification histories. The HTTP backend and durable storage were closed and reopened; after refresh and clearing browser preferences, the checkpoint restored the replay timestamp, D1/M5/H4 selections, both mounted viewports, three closed trades and two setups. The entire trading state matched its pre-restart checkpoint.

Provider requests: **0**. Paid submissions: **0**. Every cache file's SHA-256 matched before and after, including the spending ledger. The test client had no credentials and threw if a provider method was called. No browser page errors occurred.

[Machine-readable browser evidence](browser-evidence.json) includes ranges, pointer price, price scales, stop histories, journal row grouping and recovery results.

## Screenshots

| Layout | Desktop, 1440 × 1000 | Mobile, 390 × 844 |
| --- | --- | --- |
| One chart | [Desktop](1-charts-1440.png) | [Mobile](1-charts-390.png) |
| Two charts | [Desktop](2-charts-1440.png) | [First pane](2-charts-390.png), [last pane](2-charts-390-last-pane.png) |
| Three charts | [Desktop](3-charts-1440.png) | [First pane](3-charts-390.png), [last pane](3-charts-390-last-pane.png) |

Mobile panes stack in a scrolling chart workspace; the dock stays visible. All six layout/width combinations had no horizontal document overflow.

Interaction evidence: [independent zoom](independent-zoom.png), [free crosshair](free-crosshair.png), [first long drag](sl-drag-2-1-preview.png), [second long drag](sl-drag-2-2-preview.png), [short drag](sl-drag-2-3-preview.png), [Escape preview](sl-drag-cancel-preview.png), [invalid release](invalid-sl-snapback.png), [D1 warm-up](d1-warmup.png), [durable restore](durable-restored.png), [journal grouping](journal-setup-grouping.png).

## Deterministic checks and compatibility

**573 tests passed across 46 files.** Tests cover independent ranges and follow state, right-edge wheel limits, JSON viewport restoration including hidden panes, legacy shared viewport migration, newly enabled chart defaults, UTC gaps, mixed timeframes and oscillator crosshairs, drag hit testing and position selection, all cancellation paths, permission changes, buy/sell stop validation, combined risk limits, effective-after timestamps and modification history, automatic setup slot consumption and resolution, and legacy concurrent setups.

D1 checks compare incremental and batch aggregation over each revealed prefix, preserving first actual open, high/low, final revealed close, weekend gaps and separate intraday contract segments. Existing rollover blocking tests remain enabled. D1 uses Ichimoku 9/26/52 with displacement 26 and requires 78 completed daily candles. The authentic startup had **14 completed D1 candles**, so the UI reported **14 / 78 warming up**. No extra history was fetched. Existing M1 workspace, schema-v1 lifecycle migration, fingerprints, journal outcomes and disk recovery tests passed; a restored M1 pane shows `M1 (legacy)` until another timeframe is selected.

`npm run typecheck`, `npm run build` and `git diff --check` passed. The build retains the existing advisory for a client chunk above 500 kB (557.60 kB minified). The design scan found only the pinned Inter font and an existing timeline marker border; no new finding required a design change.

## Performance

The real Chromium 90-day benchmark now includes D1/H1/M5 at 100 M1 observations per batch, with a pointer over the chart. Twelve batches averaged **69.4 ms**, maximum **95.9 ms**, with no browser errors. [Raw Chromium samples](chromium-performance.json).

The existing CPU benchmark now exercises D1/M5/H1 over 1, 30 and 90 days. The 90-day run averaged **1.24 ms** per 100-observation aggregation/indicator batch, maximum **6.15 ms**, with no ordinary full-series replacements. These are machine-specific verification measurements using deterministic synthetic benchmark data, separate from the authentic trading workflow. [Raw CPU measurements](node-performance.jsonl).

## Reproduction and limits

```sh
npm test
npm run typecheck
npm run build
git diff --check
PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs node --import tsx scripts/trading-chart-ux-browser.mts
DIRECT_ONLY=1 SCENARIO=E DAYS=90 PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs node --import tsx scripts/chart-replay-browser.mts chart-ux
node --import tsx scripts/replay-benchmark.mts
```

Browser scripts use an existing external Playwright installation and Chromium; neither is a project dependency. Set `CHROMIUM_PATH` for another installed executable. The authentic workflow requires the existing validated cache. Its Vite transform exposes public chart APIs for observation only; wheel, crosshair, pan and drag interactions use actual browser pointer input.

D1 is intentionally not warm at this session start. Mobile uses scrolling stacked panes rather than desktop columns. Price-scale ranges remain browser preferences; durable checkpoints capture horizontal viewports, timeframes and indicators. As before, closing a page cannot guarantee completion of the last asynchronous disk write, so verification waits for Saved before recovery. No unresolved functional blocker remains.
