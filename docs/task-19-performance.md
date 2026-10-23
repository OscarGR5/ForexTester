# Task 19: chart rendering and replay performance

Verified October 23, 2026. Base `main`: `d1bd12c`, merged PR #16. Instrumentation-only baseline commit: `57d10ad`. The optimization follows that commit on `perf/chart-replay-optimization`.

The late 90-day isolated three-chart JavaScript batch fell **98.3%, from 3,381.73 ms to 57.21 ms**. Its p95/max was **61.70 ms** after optimization. In the complete application, late playback with a pointer over a chart improved from **27.79 to 375.90 M1 observations/s**. The nominal setting requests 400/s; these measurements do not establish nominal throughput.

## Measurement and reproduction

Machine: Intel Core i5-1240P, 16 logical CPUs, Linux x86_64, Node 24.18.0, Chromium headless shell build 1234, Lightweight Charts 5.2.1. Both revisions use the same Chromium executable, 1440 × 1000 viewport, Vite development server, React StrictMode and opt-in React Profiler. The host also runs ordinary desktop applications; numbers are local samples, not hardware guarantees.

The deterministic EURUSD fixture uses sinusoidal OHLC, a fixed 0.0002 ask spread, UTC weekend closures and isolated absent minutes. It contains 30 calendar days of pre-roll plus either two trading-range calendar days or 90 days, starting January 31, 2024. The large history contains **123,823 observations per side**, including **92,147 trading observations**. The isolated late benchmark starts with 122,621 revealed observations; the app late session starts 10,000 observations before the loaded end and retains its full preceding trading equity ledger. The additional H case resumes that late session after D and places a real pointer over chart 1 during playback.

A is M1 at 1×; B is M5/H1 at 10×; C is M5/M15/H4 at 100× near the trading start; D is the same three charts late in history. Defaults apply to every timeframe. The app includes the existing journal, realized results, trading and equity panels, plus filesystem autosave. Charts retain their normal stacked scrolling layout.

The harness separates:

- Synchronous JavaScript chart work: aggregation, public series calls, indicator calculations, cloud maintenance and synchronization. Every isolated row has 12 batches. Nearest-rank p95 equals maximum at this sample count.
- JavaScript plus waiting for two animation frames: includes drawing/scheduling opportunities, not an isolated raster/GPU paint measurement.
- Complete application wall time: Play through completion of Pause, including Playwright action overhead and any scrolling. Actual cursor advancement determines observations/s. H includes a pointer move after Play. Pause action time is not INP.
- React `Profiler.onRender` actualDuration per commit: React render work, excluding layout-effect chart mutations and browser paint. Long Tasks and a 50 ms timer probe measure main-thread blocking separately.

`replayPerformance.ts` stores stage samples and operation counts only when `globalThis.__forexReplayPerformance` is set by the harness. Ordinary use calls no profiling clock, installs no PerformanceObserver or React Profiler, and emits no profiling console output. `chart.<id>.cursor` gauges support exact paused/stepped cursor assertions.

Reproduce from this branch, with verification-only `playwright-core` and Chromium available. No package/dependency changes are required by the application:

```sh
git worktree add --detach /tmp/task19-baseline 57d10ad
ln -s "$PWD/node_modules" /tmp/task19-baseline/node_modules
# Optional: export CHROMIUM_PATH=/absolute/path/to/chromium
BENCHMARK_ROOT=/tmp/task19-baseline APP_ROOT=/tmp/task19-baseline   node_modules/.bin/tsx scripts/chart-replay-browser.mts before
VERIFY=1 node_modules/.bin/tsx scripts/chart-replay-browser.mts after
```

Run the revisions sequentially without simultaneous builds/tests. The harness uses temporary storage beginning `forextester-browser-`, the actual local backend on 3017, and Vite on 5187. It never reads or writes the user's saved backtests. Histories are seeded through the production filesystem API; no live Dukascopy download is involved. `APP_ONLY=1`, `DIRECT_ONLY=1`, `DAYS=90` and `SCENARIO=A|B|C|D|H` limit a run. Isolated charts explicitly keep the browser pointer at (200, 60) while chart 1 mounts, making hover reproducible.

The reported isolated results are `/tmp/task19-before-pointer.json` and `/tmp/task19-after-pointer.json`; app results are `/tmp/task19-before.json` and `/tmp/task19-after-app.json`. The same command writes `/tmp/task19-<label>.json` with raw arrays, counters, memory samples, checkpoint timings and browser verification results. Initial installation is outside the steady replay samples. No live session or provider cache was used.

## Root causes and changes

**Crosshair hit-testing dominated the worst case.** In the installed library, series updates call `_internal_updateCrosshair`; a visible crosshair invokes `hitTestPane`, forcing invalidated series views to rebuild coordinates before the eventual frame. This happened for intermediate candle/indicator calls, including synchronized synthetic crosshairs. Repeated callbacks also refreshed identical targets. Merely deduplicating callbacks did not eliminate the library's own hit-testing.

`ChartSynchronizer.update` now clears an existing crosshair inside the synchronous data batch. After data and the shared viewport are installed, it restores the source pointer using public coordinate APIs, including its stochastic pane, and synchronizes targets from current UTC buckets/closes. Native pointer input is distinguished from programmatic notifications; identical target time/price pairs and redundant clears are skipped. An absent crosshair incurs no clear/restore work. No paint can interleave the synchronous batch. Listeners remain registered once and are cleaned on unmount; unregistering the pointer's chart clears dependent crosshairs.

**New timestamps and repeated viewport application added work.** `ChartTimeSlots` installs only newly revealed whitespace timestamps in one bounded `setData` call before price/indicator updates. It contains no OHLC, retains no full-history display duplicate and is cleared on replacement. Every real price candle still reaches the candlestick series. Ordinary replay no longer first reapplies the old viewport for each pane and then the new viewport in `advance`.

**Some unchanged work and warm-up replacement were unnecessary.** `ReplayBars` reports the first actually changed aggregate and preserves unchanged OHLC objects. Panes and indicators skip unchanged candles. Indicator lookbacks include enabled groups only. An empty indicator line can receive its first values via `update` rather than another `setData`. Full replacement remains necessary for settings/timeframe/history changes and displaced timestamp realignment or historical observation removal. The reference `calculateIndicators` formulas are unchanged.

**Cloud maintenance and equity display allocations were repeated.** The primitive owns its cloud tail and requests redraw only when its observations change. Drawing visits visible history plus adjacent strips, including the right-edge strip. The existing crossover polygon calculation and colors remain intact. `EquityDisplay` caches completed blocks of 128 M1 observations, retaining endpoints, cash/equity/drawdown extrema and both sides of gaps. It prepares the display from those summaries and the incomplete tail. It validates ledger ancestry and rebuilds on restart, restoration or a branched render. The authoritative immutable ledger is untouched.

**Unstable callbacks defeated existing React memoization.** Timeframe/settings and journal-scope callbacks are stable. `ChartPane` and `IndicatorControls` use ordinary shallow `memo`; the existing journal comparison can now skip price-only renders. Trading state, notes, SL overlays and changed financial arrays remain visible. No new custom financial-data comparator was introduced.

Simulation and presentation retain one authoritative cursor. `useTrading` still loops through every newly revealed M1 observation, calling the original bid/ask engine and recording equity after each observation. The clock still requests 1/10/100 observations every 250 ms, and charts show the completed batch. This task adds no separate visual queue or additional refresh timer. Pause/Next install current series synchronously; history/restart/session changes rebuild from the correct prefix and cancel existing mount refresh callbacks through the established cleanup. Manual orders remain restricted to paused replay. The replay clock, saved execution cursor and ledger therefore remain aligned without a persistence schema change.

## Isolated chart measurements

Times are **mean / p95 / max ms (sample count)**. These are whole chart-layout JavaScript batches with a real pointer over chart 1, not the tiny CPU sink benchmark from Task 15.

| Range days | Case | Before JS | After JS | Before JS + two frames | After JS + two frames |
| --- | --- | ---: | ---: | ---: | ---: |
| 2 | A | 26.82 / 41.20 / 41.20 (12) | 2.48 / 3.50 / 3.50 (12) | 97.51 / 142.10 / 142.10 (12) | 53.10 / 76.40 / 76.40 (12) |
| 2 | B | 81.59 / 89.60 / 89.60 (12) | 5.66 / 8.10 / 8.10 (12) | 119.51 / 145.00 / 145.00 (12) | 52.81 / 77.70 / 77.70 (12) |
| 2 | C | 681.58 / 800.70 / 800.70 (12) | 17.06 / 25.20 / 25.20 (12) | 725.80 / 839.20 / 839.20 (12) | 76.97 / 88.50 / 88.50 (12) |
| 2 | D | 747.13 / 833.80 / 833.80 (12) | 14.90 / 18.20 / 18.20 (12) | 793.27 / 882.20 / 882.20 (12) | 75.59 / 92.10 / 92.10 (12) |
| 90 | A | 25.00 / 33.80 / 33.80 (12) | 1.65 / 2.20 / 2.20 (12) | 89.07 / 101.00 / 101.00 (12) | 58.45 / 76.60 / 76.60 (12) |
| 90 | B | 82.80 / 89.30 / 89.30 (12) | 5.30 / 7.80 / 7.80 (12) | 121.15 / 130.00 / 130.00 (12) | 51.09 / 61.10 / 61.10 (12) |
| 90 | C | 741.06 / 815.70 / 815.70 (12) | 14.73 / 17.60 / 17.60 (12) | 787.34 / 863.10 / 863.10 (12) | 71.73 / 92.20 / 92.20 (12) |
| 90 | D | 3381.73 / 3639.70 / 3639.70 (12) | 57.21 / 61.70 / 61.70 (12) | 3528.64 / 3792.40 / 3792.40 (12) | 256.99 / 287.90 / 287.90 (12) |

The historical 228/310 ms reference used another chart/timeframe/pointer configuration. It is not the current baseline. Current C and D JavaScript work improves about 98%, exceeding the 30% target. The late **two-frame p95 of 287.90 ms** remains above 250 ms, despite JavaScript p95 being 61.70 ms.

Stage timings for late 90-day D, per pane call rather than per three-pane batch:

| Stage | Before mean / p95 / max (n) | After mean / p95 / max (n) |
| --- | ---: | ---: |
| ReplayBars.advance | 0.01 / 0.10 / 0.10 (36) | 0.01 / 0.10 / 0.10 (36) |
| Time-slot preparation | 0.00 / 0.00 / 0.00 (0) | 3.83 / 9.90 / 14.80 (36) |
| Candlestick series | 692.95 / 2045.20 / 2052.30 (36) | 1.60 / 4.20 / 9.10 (36) |
| Indicator calculation | 0.61 / 1.00 / 3.00 (36) | 0.27 / 0.50 / 0.50 (36) |
| Indicator series | 433.63 / 1203.40 / 1214.90 (36) | 11.72 / 36.00 / 36.00 (36) |
| Cloud maintenance | 0.00 / 0.00 / 0.10 (36) | 0.01 / 0.10 / 0.10 (36) |
| Cloud drawing callback | 0.59 / 0.80 / 0.80 (24) | 0.57 / 0.70 / 0.70 (17) |
| Applied viewport call | 0.01 / 0.10 / 0.10 (50) | 0.00 / 0.00 / 0.10 (25) |

Clock resolution makes very short samples appear zero. Viewport timing covers calls that applied a range; its request/application counters also capture skipped requests. Cloud drawing is canvas API callback time, excluding compositor/raster completion.

Across D's 12 batches, candlestick updates stayed **361 → 361** and indicator updates **2,445 → 2,445**, with **zero ordinary full-history price or indicator replacements** in both revisions. The improvement preserves the same observations. The new bounded time-slot series made 24 batch calls; viewport requests fell **72 → 36** and applied ranges **50 → 25**. The cloud requested five changed-data redraws. In M1 case A, redundant old-tail price updates fell **24 → 12** for the same 12 new observations. Gap realignment and indicator settings/rebuild behavior are tested separately.

## Whole application, responsiveness and equity

Each row is one playback interval, approximately 6.2 seconds plus input/action completion. Sample counts below are processed observations, not attempted timer ticks. H's baseline Pause took an additional 22.5 seconds; its wall-clock denominator includes that delay.

| Days | Case | M1 processed before / after | Observations/s before / after | Pause action ms before / after |
| --- | --- | ---: | ---: | ---: |
| 2 | A | 25 / 25 | 3.88 / 3.91 | 163.55 / 58.81 |
| 2 | B | 240 / 240 | 37.94 / 38.08 | 52.10 / 49.79 |
| 2 | C | 2400 / 2400 | 379.12 / 380.61 | 61.99 / 49.09 |
| 2 | D | 2400 / 2400 | 379.99 / 380.67 | 57.24 / 50.92 |
| 90 | A | 25 / 25 | 3.89 / 3.91 | 135.93 / 98.26 |
| 90 | B | 240 / 240 | 38.00 / 38.07 | 57.26 / 47.18 |
| 90 | C | 2400 / 2400 | 379.71 / 380.83 | 62.43 / 48.92 |
| 90 | D | 2200 / 2400 | 217.01 / 381.93 | 3874.68 / 39.78 |
| 90 | H | 800 / 2800 | 27.79 / 375.90 | 22504.08 / 1174.90 |

1× and 10× throughput did not materially regress. Early 100× playback is already largely clock-limited. Late D throughput increased **76%**; H increased **13.5×**. There is no claim of sustained 400 observations/s or guaranteed 100× wall-clock speed.

90-day application stage samples use **mean / p95 / max ms (n)**. Chart-pane samples exclude browser drawing and are per pane, so they should not be mistaken for the complete three-chart frame cost.

| Case | Metric | Before | After |
| --- | --- | ---: | ---: |
| A | M1 execution + equity | 0.09 / 0.30 / 0.60 (25) | 0.10 / 0.30 / 0.40 (25) |
| A | Chart pane layout effect | 0.80 / 1.30 / 1.30 (25) | 0.50 / 0.80 / 0.90 (25) |
| A | React render per commit | 13.55 / 18.70 / 19.90 (30) | 10.49 / 15.70 / 15.90 (30) |
| A | Equity display preparation | 0.00 / 0.00 / 0.10 (50) | 0.00 / 0.00 / 0.10 (50) |
| A | Long Tasks | 56.00 / 56.00 / 56.00 (1) | 58.00 / 58.00 / 58.00 (1) |
| A | 50 ms timer lag | 12.80 / 57.60 / 85.90 (102) | 11.74 / 53.20 / 61.90 (103) |
| B | M1 execution + equity | 0.19 / 0.20 / 2.30 (24) | 0.21 / 0.20 / 2.20 (24) |
| B | Chart pane layout effect | 1.62 / 3.60 / 5.40 (48) | 2.01 / 4.80 / 5.10 (48) |
| B | React render per commit | 15.21 / 20.10 / 20.30 (29) | 11.76 / 16.80 / 18.10 (29) |
| B | Equity display preparation | 0.00 / 0.00 / 0.10 (48) | 0.01 / 0.10 / 0.30 (48) |
| B | Long Tasks | 0.00 / 0.00 / 0.00 (0) | 0.00 / 0.00 / 0.00 (0) |
| B | 50 ms timer lag | 6.38 / 41.80 / 54.50 (112) | 5.79 / 43.40 / 63.60 (113) |
| C | M1 execution + equity | 0.35 / 0.80 / 2.50 (24) | 0.50 / 0.80 / 3.40 (24) |
| C | Chart pane layout effect | 8.35 / 26.50 / 42.40 (72) | 4.77 / 14.20 / 16.70 (72) |
| C | React render per commit | 19.66 / 28.90 / 34.30 (29) | 12.12 / 18.10 / 18.50 (29) |
| C | Equity display preparation | 0.02 / 0.10 / 0.10 (48) | 0.02 / 0.10 / 0.20 (48) |
| C | Long Tasks | 65.08 / 88.00 / 88.00 (12) | 0.00 / 0.00 / 0.00 (0) |
| C | 50 ms timer lag | 18.70 / 97.80 / 157.10 (92) | 11.96 / 53.40 / 69.50 (101) |
| D | M1 execution + equity | 0.24 / 0.20 / 2.10 (22) | 0.14 / 0.30 / 0.70 (24) |
| D | Chart pane layout effect | 40.92 / 144.00 / 150.60 (66) | 15.70 / 45.90 / 61.30 (72) |
| D | React render per commit | 31.07 / 49.10 / 53.30 (25) | 10.50 / 14.40 / 18.20 (27) |
| D | Equity display preparation | 2.56 / 3.60 / 4.10 (44) | 0.10 / 0.30 / 0.30 (48) |
| D | Long Tasks | 153.83 / 238.00 / 243.00 (63) | 78.80 / 127.00 / 173.00 (70) |
| D | 50 ms timer lag | 238.72 / 461.10 / 564.90 (23) | 68.04 / 182.80 / 194.60 (53) |
| H | M1 execution + equity | 0.23 / 0.60 / 0.60 (8) | 0.22 / 0.40 / 3.10 (28) |
| H | Chart pane layout effect | 1120.46 / 3283.40 / 3538.60 (24) | 16.13 / 45.10 / 59.70 (84) |
| H | React render per commit | 18.35 / 33.10 / 33.10 (15) | 11.09 / 19.10 / 27.30 (32) |
| H | Equity display preparation | 1.87 / 3.20 / 3.20 (16) | 0.10 / 0.30 / 0.40 (56) |
| H | Long Tasks | 1180.88 / 3605.00 / 3973.00 (24) | 83.43 / 134.00 / 156.00 (83) |
| H | 50 ms timer lag | 925.14 / 4053.90 / 4053.90 (8) | 77.17 / 174.90 / 186.20 (51) |

Late D equity preparation fell from **2.56 to 0.10 ms** per preparation, approximately 96%. React render duration per commit fell from **31.07 to 10.50 ms**. H's maximum observed Long Task fell **3,973 → 156 ms**; its timer-probe maximum fell **4,053.90 → 186.20 ms**. Long Task counts can increase because the faster run processes many more frames; duration and processed work matter together. B's per-pane JavaScript average increased by about 0.39 ms, while throughput and blocking stayed comparable.

V8 heap samples after Pause, without forced collection, in MiB:

| Case | Before | After |
| --- | ---: | ---: |
| A | 166.1 | 128.3 |
| B | 85.1 | 173.0 |
| C | 210.8 | 142.1 |
| D | 134.7 | 272.4 |
| H | 602.8 | 398.7 |

These include Vite/development code, loaded data, temporary arrays and caches; GC timing is uncontrolled and native canvas memory is excluded. They do not establish a leak or a precise retained-memory improvement. The new equity cache retains references to financial points and display summaries instead of repeatedly allocating a full ledger reconstruction. It clears/rebuilds when ancestry changes; gap-heavy displays can still retain many representatives.

Actual running filesystem checkpoints after optimization:

| Case | Start after Play ms | Completed request ms | Request bytes | Execution cursor | Equity observations |
| --- | ---: | ---: | ---: | ---: | ---: |
| A | 5056.76 | 48.88 | 5,919 | 31,696 | 20 |
| B | 5060.75 | 82.02 | 34,991 | 31,886 | 210 |
| C | 5079.24 | 82.26 | 326,001 | 33,786 | 2,110 |
| D | 5079.18 | 231.20 | 334,122 | 115,724 | 84,048 |
| H | 5242.81 | 184.54 | 311,455 | 117,624 | 85,948 |

Running saves start at about five seconds. The difference between execution cursor and equity count is the 31,676 context observations, which never enter the trading ledger. Request completion is elapsed HTTP/scheduling time, not isolated persistence CPU. The harness also waits for an exact matching paused cursor after Save now and compares restored trading state, ledger points and summaries.

## Correctness and browser verification

The final automated suite passes **446 tests across 34 files**. Commands:

```sh
npm run typecheck
npm run build
npm test
git diff --check
```

New/extended deterministic checks cover actual dirty ranges and all M1/M5/M15/H1/H4 aggregates; partial buckets and weekend gaps; full-reference indicator timestamps/values (eight decimal places), first warm-up appends, custom Bollinger settings/visibility; cloud unchanged tails, crossover colors and visible-history drawing; equity endpoints/extrema/gap boundaries and ancestry changes; crosshair deduplication, native/programmatic handoff, source stochastic-pane restoration, absent-crosshair avoidance and cleanup. A new StrictMode comparison runs same-candle short stops, a weekend gap-through short stop, two missing ask marks and explicit setup grouping at 1×/10×/100×, comparing the complete engine state, every equity point and exact maximum drawdown.

Existing tests continue covering bid/ask entry and exit fills, commissions, original risk/R, independent stops and two positions, manual closes, no future data, CSV/notes, viewport navigation/following, 1/2/3 layouts, settings/timeframe persistence, StrictMode mount/unmount, pending refresh cancellation, running restart and history reload, autosave, filesystem restoration and resumed sessions without duplicate fills/fees/equity. No execution, accounting, indicator formula or saved-session schema was changed.

Real Chromium with the actual local backend and real Lightweight Charts passed:

- All A–D configurations and H hover playback, with journal/equity enabled and no page exceptions.
- Two manual positions, independent SL edits, playback over hundreds of M1 observations, one automatic SL exit and one pending manual exit. Full engine objects, equity summaries and **every saved equity observation** match a Node reference replay at the exact processed cursors.
- Timeframe changes M5 → M1 → M5, 2 → 3 chart count, zoom, scroll/drag and a Bollinger length edit during playback. Orders remain disabled during Play. Pause and Next assert all three chart cursor gauges equal the actual execution cursor.
- Notes and a downloaded CSV match the full reference CSV byte for byte. Save now waits for the matching cursor, refresh restores paused, and the next step retains unique trades, fees and equity. The edited Bollinger length persists.
- Restart after valuable trading is explicitly confirmed in the isolated fixture, clears trades/equity to the starting observation, and leaves three chart roots.
- 1440 px and 390 px document widths match the viewports, with exactly three chart roots and working indicator panes. Screenshots `/tmp/task19-verified-1440.png` and `/tmp/task19-verified-390.png` were visually inspected. The UI detector reported no findings for changed components.

The captured reference-equivalent trade example:

| Position | Lots | Ask entry | Exit | Reason | Total fee USD | Net USD | Original-risk R |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| 1 | 0.1 | 1.099513338389368 | 1.099180000000000 | stop_loss | 0.70 | -4.0333838937 | -0.1221002337 |
| 2 | 0.2 | 1.099513338389368 | 1.099288986905972 | manual | 1.40 | -5.8870296679 | -0.0891072753 |

At the captured save there are **3,413** full equity observations, cash **$99,990.0795864384**, and exact maximum equity drawdown **$43.847860797978**. Assertions compare unrounded values. Rerun manual exit prices can differ because UI action duration changes the paused cursor; each run compares against the reference at its own exact cursor.

## Files and limits

| Responsibility | Files |
| --- | --- |
| Chart batches, stable React props and cursor gauges | `frontend/src/App.tsx`, `IndicatorControls.tsx`, `chartTimeSlots.ts` |
| Aggregation, indicators, cloud and synchronization | `frontend/src/replayBars.ts`, `indicatorSeries.ts`, `ichimokuCloud.ts`, `chartSync.ts` |
| Cached equity display | `frontend/src/equityDisplay.ts`, `EquityChart.tsx` (preserves existing exported helpers) |
| Disabled-by-default instrumentation | `frontend/src/replayPerformance.ts`, `main.tsx`, `useTrading.ts` (instrumentation only) |
| Regression tests | `frontend/src/App.interaction.test.tsx`, `chartTimeSlots.test.ts`, `equityDisplay.test.ts`, `replayBars.test.ts`, `ichimokuCloud.test.ts`, `chartSync.test.ts`, `replayEquity.test.tsx` |
| Reproducible browser fixtures and verification | `scripts/chart-replay-browser.mts`, `chart-replay-data.ts`, `chart-replay-fixture.ts`, `chart-replay-verification.ts` |
| Documentation | `README.md`, `docs/task-19-performance.md` |

No dependencies, cloud services, new trading functionality or persistence technology were added. No outstanding product decision is required for this implementation; merge still requires project-lead approval.

The late two-animation-frame proxy still exceeds 250 ms at p95. H's complete Pause action still takes about **1.17 seconds**, including driver movement/scrolling and browser scheduling; these tests do not measure production INP. Long-history initial installation, genuine settings/timeframe changes and restoration still scale with history. The library still reindexes series data internally and performs canvas drawing; preserving every candle/indicator observation leaves real work to do.

These are development-mode desktop Chromium samples with mobile viewport emulation, not physical-device, Firefox/Safari or live-provider measurements. They are sampled playback intervals, not a complete 90-day wall-clock run. Exact full-speed execution invariants use deterministic tests. The production build passes with the existing nonfatal warning about a chunk larger than 500 kB. Financial precision, saved history, entry/SL/gap/commission behavior, CSV structure and persistence schemas remain intact.
