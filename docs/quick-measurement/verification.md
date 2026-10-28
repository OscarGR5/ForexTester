# Quick chart measurement

Shift + left drag measures between revealed candle anchors. Shift + click, free movement, then another click finishes the same ruler without holding the button. A 3 px movement threshold distinguishes a drag from the first click. Ordinary clicks on that chart and Escape clear completed rulers. Escape, pointer cancellation, capture loss, and window blur cancel active gestures. Each chart owns its overlay independently.

The candlestick primitive renders only signed pips and real bar count with calendar elapsed time. EURUSD/6E use 0.0001 per pip; local instrument metadata supplies pip size where available. Pip calculations retain floating-point precision, with one decimal for display and no negative zero. Reverse gestures use signed price movement and absolute bar/time spans.

Anchors come from `ReplayBars.candles`, after aggregation into the current chart timeframe and limited to revealed observations. Binary search compares actual candle timestamps' public logical indices, so other series' slots cannot inflate the bar count. Future/projection/left whitespace clamps to the nearest available real candle. Empty history cannot start a ruler. Calendar elapsed time uses the selected UTC timestamps, including weekend and missing-candle gaps. Rewinds invalidate anchors no longer revealed.

`MeasurementPrimitive` stores time/price endpoints and converts them at draw time using public chart APIs. It clips drawing to the candle pane, bounds the two-line label inside the plot, and avoids rendered stop annotations. It does not affect autoscale. `useMeasurement` owns native capture handlers, temporarily disables native scroll/scale, and restores a deep copy of the original interaction options. Compatibility mouse clicks are consumed within the chart; trading-control keyboard clicks remain available after completion. Shift gestures cannot select stops or initiate trades during placement. Active stop drags retain priority. Pointer movement updates only the primitive, with no React state update or candle-series replacement.

Timeframe, session, and chart-layout changes clear overlays. Teardown releases capture, restores interactions, removes native listeners, and explicitly detaches the primitive before chart removal, including React StrictMode cleanup. No dependency, persisted drawing, synthetic price series, financial calculation, execution, or market-data change was added.

## Verification

The final Chromium run passed **48 scenario groups**, with **zero page errors** and **zero external requests**. The full suite passed **864 tests across 63 files**, including **33 new unit tests**. Typecheck and the production build pass.

Unit coverage includes positive/negative/zero pips, EURUSD/6E pip equivalents, alternate instrument pip sizes, rounding, same-bar and multi-bar spans, weekend/missing candles, reverse direction, elapsed formatting, empty history, projected slots, unrevealed observations, both gesture styles, cancellation, lifecycle resets, listener removal, trading isolation, and nested interaction-option restoration.

The Chromium harness runs the production App, charts, trading components, keyboard handlers, and disk session store with deterministic M1 fixtures and disposable storage. Public chart probes and renderer probes are injected by the test Vite transform and do not ship. Every external request is blocked, archive discovery is stubbed, and no user session or archive is accessed.

Browser coverage includes:

- Shift drag and click-to-click on H1, M5, and D1 in every pane of 1-, 2-, and 3-chart layouts.
- Exact revealed endpoint indices/timestamps, calendar spans, signed movement, and unchanged viewport during measurement.
- Mouse movement across chart boundaries and clamping to revealed history.
- Horizontal/vertical zoom preserving completed anchors; native pan and zoom functioning after completion and cancellation.
- Placement priority, Shift clicks leaving draft selection untouched, ordinary order placement, next-observation execution, and one committed stop drag.
- Shift + Arrow and Ctrl + Shift + Arrow replay shortcuts.
- Clearing on timeframe/layout changes, reload, and switching saved sessions.
- Tiny neutral measurements and labels at the top/right and bottom/left plot edges. Renderer text and bounds are asserted in Chromium.

Screenshots were visually inspected for the red/green two-line labels, the three-chart layout, and the bounded edge label. Representative examples: [green H1](green-1-0-H1.png), [red H1](red-1-0-H1.png), [green M5](green-1-0-M5.png), [red D1 in three charts](red-3-2-D1.png), and [top-right neutral](top-right.png). Full numeric results and rendered labels are in [browser-evidence.json](browser-evidence.json).

Reproduce with an existing Playwright installation:

```sh
npm test -- --maxWorkers=2 --reporter=verbose
npm run typecheck
npm run build
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs \
  node --import tsx scripts/quick-measurement-browser.mts
```

Chromium desktop mouse/keyboard input is covered; touch and other browser engines are outside this feature's verification. The production build retains Vite's existing advisory about a chunk larger than 500 kB.
