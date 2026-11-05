# M1 regression channel

November 5, 2026. Base: `fc44dfe07f50f73fb9a1957ccc26c07048735ea4` on `main`, including adaptive chart batching and the Stochastic optimization.

## Straight endpoint rendering

The staircase fix starts from `59a9835` on `main`. Each boundary now draws one direct segment between the first and last original M1 observations. Only these endpoints are projected through the chart's actual bucket coordinates and fractional M1 positions. Drawing and 5px deletion hit-testing share the same projected segments. M1 OHLC4, OLS, SER, ±2 SER, colors, widths and bottom order are unchanged; no replay, indicator or trading code changes.

The geometry tests cover M1, M5, M15, H1, H4 and D1 with missing minutes, a weekend and partial sessions. Each path must contain exactly two points, preserve both endpoint prices, and share the other boundaries' screen direction. An irregular M1 gap also verifies that deletion hits the direct segment and rejects the former intermediate bend.

Chromium 156.0.8078.4 passes at 1440 × 1000 and 1100 × 800. A 13,536-observation M1 segment spans November 23 through December 7, 2022, including weekends and session gaps. H4 and D1 each emit exactly three two-point paths; their screen vectors are parallel, and inverse chart coordinates recover both endpoint prices within 1e-12. Both timeframes retain identical coefficients and endpoint prices. Screenshots were visually inspected: [H4 1440px](straight-h4-1440.png), [D1 1440px](straight-d1-1440.png), [H4 1100px](straight-h4-1100.png), [D1 1100px](straight-d1-1100.png). [Browser results and endpoint geometry](straight-verification.json).

The same run passes deletion through all three boundaries, enabled/disabled gesture behavior, four-chart removal and sharing, anchor and deleted-anchor reload persistence, immediate redraw, forward replay and backward review. The candle-over-channel pixel control still passes. Existing trading state is preserved during channel gestures; no page errors, external requests or history downloads occurred. The harness uses disposable sessions and leaves the user's store untouched.

Validation: `npm run typecheck`, `npm run build`, the 34 targeted primitive/gesture/persistence tests, and `git diff --check` pass. The full suite (`npm test -- --maxWorkers=2 --testTimeout=15000`) returns **1,021 passed / 1 failed across 74 files** in 274.56 seconds. The failure is the existing `workflow.test.tsx:739` UI-cleanup assertion: it counts both the global and active-session preference keys but expects one. Running that exact test (`--testNamePattern='previews UI cleanup'`) on untouched `main` at `59a9835` reproduces the same failure. It is outside this rendering fix. The production build retains the existing nonfatal bundle-size warning.

## PR #45 follow-up: deletion and rendering order

With Regression enabled, Ctrl + Click within 5 CSS pixels of any rendered segment deletes the entire channel before resolving a replacement candle. The hit test measures perpendicular distance to the same projected screen segments used for drawing, including their endpoints. It runs only on an enabled Ctrl gesture. Clearing the existing shared anchor to `null` removes all panes immediately and uses the existing autosave mechanism; the toggle remains enabled. Disabled gestures cannot delete or reposition the channel.

The primitive now uses `bottom` z-order. Its colors, widths, M1 calculations, timestamp projection and replay behavior are unchanged.

All **999 tests across 71 files pass** with `npm test -- --maxWorkers=2 --testTimeout=15000`. The first run passed 998 tests; an existing session-restore test exceeded its default five-second timeout while Chromium was running. The isolated rerun used a 15-second timeout without changing that test or application behavior. Targeted math, primitive, interaction and persistence tests and the extended four-chart App integration test also pass. Typecheck, production build and diff checks pass; the existing nonfatal bundle-size warning remains.

Production Chromium 156.0.8078.4 passes at 1440 × 1000 and 1100 × 800: deletion through each of the upper/middle/lower lines, disabled-toggle protection, four-pane removal, durable empty-anchor recovery, enabled-toggle preservation and immediate drawing of a new channel. An open trading position remains unchanged. No page errors or new history requests occurred.

Rendering order was checked at a real candle-body/channel intersection. The rendered pixel is candle white `[255,255,255,255]` at `bottom` order, becomes the amber channel color when the same primitive is temporarily raised to `normal` in the disposable browser, then returns to white when `bottom` is restored. [Pixel and deletion results](deletion-verification.json); [current M5 screenshot](behind-candles-1440.png). The existing browser harness reproduces these checks. The original performance evidence below predates this follow-up; regression math and replay code were not changed.

## Implementation

`App` owns one anchor and one `RegressionCalculator` for its loaded instrument/session. The calculator reads authoritative M1 OHLC4 prices with consecutive observation indices. It returns one shared result for all panes, independent of displayed timeframe or layout. SER uses residual SSE divided by `n - 2`; boundaries use exactly ±2 SER. It emits no channel before three observations are revealed.

Forward replay visits only newly revealed M1 observations. A fixed price origin, centered covariance and recursive least-squares residual updates avoid cancellation from subtracting nearly equal variance sums. Backward review and anchor replacement rebuild only the selected M1 segment. Changing timeframe or layout reuses the calculation without reading OHLC again. Missing minutes and weekends remain absent observations.

The existing M1 pipeline supplies all data. No fetch, dependency, indicator formula, timeframe aggregation or candle-series change was added. The toggle uses the existing per-session UI preference envelope, defaults off, and controls positioning only. The optional `regressionAnchor` checkpoint field stores a UTC M1 timestamp. Existing session records without it retain their original digests and restore normally. Validation checks the anchor against the original history and, for legacy futures, the session's contract. Restart can temporarily place the cutoff before the saved anchor.

`RegressionChannelPrimitive` attaches to the existing candlestick series through the [Lightweight Charts series primitive API](https://tradingview.github.io/lightweight-charts/docs/plugins/series-primitives). It anchors the starting and ending M1 timestamps to the library coordinates of their displayed candle buckets, then uses their fractional positions within those buckets. Existing indicator whitespace is respected. The three direct endpoint segments share the same x coordinates and constant price offsets. There are no extra series, time slots, labels, OHLC4 dots or fills. Amber distinguishes the solid 2px middle line from the 1px boundaries.

Drawing and hit-testing project only the two original endpoints, with constant work per pane regardless of history length. Canvas clipping handles endpoints outside the viewport. Mathematical calculations still use every revealed M1 observation at full JavaScript numeric precision.

Native capture handlers reserve the complete enabled Ctrl gesture before trading, stop dragging, ruler and chart handlers. They also cover draft SL annotations over the plot. Axes, oscillator panes and projected whitespace cannot select an anchor. Disabling the toggle leaves the existing channel updating and visible.

## Automated verification

New tests cover OHLC4, known OLS coefficients, independent two-pass OLS/SER comparisons, fixed boundaries, flat/linear data, future OHLC access guards, incremental reads, backward review, anchor replacement, missing minutes/weekends, bounded projection and exact projected prices on all six timeframes. Gesture tests cover M1/M5 placement, toggle behavior, full gesture consumption, whitespace, cleanup and draft overlays. Persistence tests cover disk recovery, independent sessions, legacy records, invalid anchors and anchors beyond a restarted cutoff. The production App integration test checks four panes sharing the identical result object, timeframe/layout changes, review, replacement, unchanged candle data and both enabled/disabled preference restoration.

The original feature version passed **991 tests across 71 files** (`npm test -- --maxWorkers=2`, 291.78 seconds). `npm run typecheck`, `npm run build` and `git diff --check` pass. The production build retains the existing nonfatal warning about a chunk larger than 500 kB; the frontend bundle is 621.55 kB / 193.95 kB gzip.

## Chromium verification

Production Vite build, Chromium 156.0.8078.4, 1440 × 1000 and 1100 × 800. Real installed EURUSD data supplies 152,242 M1 observations including pre-roll. Both widths pass:

1. Default-off toggle, enabling, and native Ctrl + Click on M5.
2. Identical underlying coefficients and endpoint prices on M5, H1 and D1.
3. Next Min and M5 candle advances, incorporating every newly revealed M1 observation.
4. Backward M1 review with unchanged trading state, then return to current replay.
5. Anchor replacement and disabled repositioning with the channel retained.
6. Four-chart sharing, with Ichimoku, Bollinger, Stochastic, live SL and entry/execution overlays.
7. Ctrl anchoring during a second trade draft without selecting/submitting the draft or changing the open position.
8. Durable anchor and toggle restoration after a real reload.

No page errors, external requests, extra history downloads or horizontal overflow occurred. All fixture sessions and builds were isolated under `/tmp`; the user's session store was not used. [Machine-readable browser results](browser-verification.json) include exact coefficients and observed instrumentation.

For the first anchor, both widths returned `n = 146`, slope `2.1376996712710915e-7`, intercept `1.0466565222253283` and SER `0.00009167790900013783`. The latest middle/upper/lower prices were respectively `1.0466875188705618`, `1.046870874688562` and `1.0465041630525616` on every displayed timeframe.

Screenshots: [M5](m5-1440.png), [H1](h1-1440.png), [D1](d1-1440.png), [four charts at 1440px](four-1440.png), [four charts at 1100px](four-1100.png). The H1/D1 screenshots zoom the existing time axis to inspect the short segment.

Reproduce from the repository root:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs \
  node --import tsx scripts/regression-channel-browser.mts
```

Set `CHROMIUM_PATH` when the executable differs from the script's local default. The harness requires the installed local archive and writes only disposable sessions plus verification artifacts.

## Performance

The comparison uses the pre-feature `main` source and the feature with no channel / with an active channel. The same production browser harness, M1 source, initial cursor, four-chart layout `[D1,M5,H4,H1]`, indicator presets and navigation/switch sequence are used. Measurements run sequentially, outside automated test execution. The active channel starts at the first loaded M1 observation to exercise a long anchored segment.

492,712 loaded M1 observations; initial active segment **474,293 observations**. Chromium 156.0.8078.4, 1440 × 1000, eight samples per navigation and four per switch. Latency measures native input dispatch to two animation-frame opportunities after the expected cursor/timeframe is installed. It includes existing chart work and deferred drawing, and is not a physical display measurement.

| Action | main, ms | Feature, no channel, ms | Active channel, ms |
| --- | ---: | ---: | ---: |
| Advance D1 | 974.4 | 784.6 | 792.8 |
| Advance H4 | 663.2 | 640.0 | 640.9 |
| Advance M5 | 591.6 | 523.8 | 565.2 |
| Switch to H1 | 1,280.9 | 1,199.2 | 1,399.2 |
| Switch to H4 | 993.3 | 944.5 | 1,081.4 |
| Switch to D1 | 1,089.9 | 1,041.8 | 1,164.8 |
| Switch to M5 | 2,049.4 | 2,068.4 | 2,637.9 |

The initial long-segment fit took **9.4 ms**. Active-channel D1 advances averaged **0.138 ms** of regression calculation and **5.21 ms** of total regression drawing across panes. H4/M5 calculation was below the browser timer's per-sample resolution; drawing averaged **4.85 / 5.18 ms**. Switching performed **zero regression observation processing**, with **1.10–3.00 ms** mean regression drawing per action. Every measured forward action asserted that both execution and regression observation counts exactly equal the replay delta.

Separated runs showed slower switching with an active channel, particularly return to M5. A second pass alternated channel absence/presence at the same paused cursor in the same browser, reversing order on alternate iterations. Its four samples per mode/direction returned:

| Alternating switch | No channel, ms | Active channel, ms |
| --- | ---: | ---: |
| H1 | 1,292.8 | 1,219.7 |
| H4 | 922.5 | 952.3 |
| D1 | 1,096.3 | 1,065.2 |
| M5 | 2,024.2 | 1,906.2 |

That control does not reproduce a consistent switching slowdown. The first separated run also spent more time in unchanged indicator calculation/series installation, while measured regression drawing remained small. These short desktop samples show real host/GC variation; they do not establish either a speedup or zero overhead. Nearest-rank p95 equals the maximum at these sample sizes.

[Summary CSV](benchmark-summary.csv) includes mean/p95/max and regression stage timings. Raw evidence: [main](benchmark-before.json), [no channel](benchmark-after-off.json), [active channel](benchmark-after-on.json), [alternating control](benchmark-paired.json). The `baseCommit` identifies the common pre-feature revision; feature runs used the implementation included in this PR.

Reproduce with `scripts/regression-channel-benchmark.mts`. `BENCH_ROOT` selects another source checkout; its dependencies must already resolve. `BENCH_LABEL`, `BENCH_OUTPUT`, `SAMPLES`, `REGRESSION=1`, `PLAYWRIGHT_MODULE` and `CHROMIUM_PATH` configure output and browser selection. `PAIRED_SWITCHES=1 REGRESSION=1` adds the alternating same-cursor control. The script uses this repository's unchanged history/execution fixture builders and compiles the selected frontend source. It asserts that execution and regression observation counts exactly match each cursor delta, and that timeframe switching processes zero observations.

The baseline source was extracted with `git archive fc44dfe07f50f73fb9a1957ccc26c07048735ea4` into a temporary directory, with `node_modules` linked to the installed workspace dependencies. It did not require changing the active branch. Runs used `BENCH_LABEL=before BENCH_ROOT=<baseline>`, `BENCH_LABEL=after-off`, `BENCH_LABEL=after-on REGRESSION=1`, then `BENCH_LABEL=paired REGRESSION=1 PAIRED_SWITCHES=1 SAMPLES=4`. The first three runs used the default eight navigation samples.

## Limits

A short M1 segment occupies a fraction of an H4/D1 candle and can look small at a wide zoom. A perfectly linear segment has zero SER, so all three boundaries coincide by definition. The primitive follows the existing price range and can be clipped by a manually chosen scale; it does not change indicator or price autoscaling. The straight segment interpolates screen coordinates only between the original M1 endpoints; intermediate observation prices no longer supply rendering vertices. Backward review and new anchors take time proportional to their selected segment; forward updates are incremental. Browser checks cover desktop Chromium, not Firefox or Safari.
