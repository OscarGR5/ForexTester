# Task 15 verification

Verified October 23, 2026. Base: `e48d102` (`main`, merged PR #12).

## Implementation and files

| Area | Files |
| --- | --- |
| History coordination and validation | `frontend/src/historyLoader.ts`, `history.ts`, `App.tsx`; `backend/src/history.ts`, `app.ts` |
| Replay and chart updates | `useReplay.ts`, `useTrading.ts`, `replayBars.ts`, `chartSync.ts`, `indicatorSeries.ts`, `ichimokuCloud.ts` |
| Account accounting and visualization | `equity.ts`, `EquityChart.tsx`, `trading.ts`, `style.css` |
| Scope-aligned analytics and journal | `analytics.ts`, `TradingJournal.tsx`, `RealizedChart.tsx` |
| Deterministic regression coverage | History loader, backend boundary, equity, incremental bars/indicators, replay/equity hooks, existing App/history tests |
| Documentation and measurements | `README.md`, this report, `scripts/replay-benchmark.mts` |

No production dependencies were added. Trade execution, commission pricing, original-risk denominators, two-position limit, indicator settings/presets and bid/ask separation remain intact. No take profits or dynamic sizing were added.

## Historical loading and causality

The selected interval allows 1–90 completed UTC calendar days, start inclusive and end exclusive. Both the 30-calendar-day pre-roll and selected interval are split into chronological chunks of at most seven days, with two chunk workers. Each response is validated before merging independent bid/ask observations. Sorting and duplicate-conflict checks preserve original prices/timestamps and market gaps.

Successful chunks live in a bounded, per-mounted-loader memory cache (40 chunks). Retry never accepts partial history and reuses completed chunks. The existing Dukascopy instrument/side/day disk cache avoids downloading days again when boundaries change. Obsolete browser requests are aborted; server-side provider work already running can still finish because the library exposes no cancellation interface. Errors identify failed UTC chunks without exposing upstream details.

Before replay the full-history viewer remains available. Start Replay hides later prices and reveals all earlier context plus the first available M1 observation at/after the chosen timestamp. Only that first trading observation initializes engine/equity state. Restart returns to the same chosen start. Pending orders still execute only at a later eligible synchronized opening. Pre-start history creates no orders, fills, journal outcomes or equity observations.

Default displaced H4 cloud readiness requires 78 prior H4 observations (52 + 26), counted from actual observations. EURUSD history before the library's recorded M1 boundary returns empty, with no fabricated warm-up.

## Accounting and scope

The statistics selector drives both KPIs and realized results/drawdown. Completed setups attribute their combined net result at final exit; partial setups are excluded. Closed positions attribute each exit in engine order, including simultaneous exits and partial setups. Setup attribution is explicitly labeled analytical, not broker cash flow.

The persistent equity ledger appends after every M1 engine event. Cash adds gross realized PnL and deducts entry fees at entry and exit fees at closure. Equity adds open gross PnL from bid close for longs and ask close for shorts. Same-candle entries/stops incur each fee once. Moving a stop changes no cash transaction. The alternate closed-net-plus-open-marks-minus-open-entry-fees identity is tested independently.

The supplied example produces $9,996.50 cash and $9,976.50 equity while open, then $9,973.00 cash/equity on closure. A browser fixture with a 0.1-lot short showed $9,999.65 entry cash, $9,997.65 equity, unavailable equity with unchanged cash when ask was missing, and $9,989.30 cash/equity after a later SL at 100×.

Realized drawdown uses the selected attribution scope. Equity drawdown uses every valid M1 equity observation and starts its high-water mark at the fixed reference balance. Missing marks create unavailable observations; no high-water mark or drawdown is invented. Clock gaps break displayed lines. Equity at/below zero produces an explicit percentage-unavailable condition. Display downsampling preserves financial extrema and gap boundaries without changing ledger values or maximum drawdown.

## Automated checks

`npm run typecheck`, `npm run build`, `npm test`, and `git diff --check` passed. The final suite has **286 passing tests across 20 files**, with no live provider dependency.

Coverage includes 1/7/30/90-day validation and 91-day rejection, leap/year/month boundaries, two-worker concurrency, side merging and conflicts, abort/failure/retry/cache behavior, actual H4 counts, provider boundary clipping, context versus tradable history, chosen replay start, every intervening candle at all speeds, stops and fees, cash reconciliation, both mark sides, two simultaneous positions, missing bid/ask, same-candle stops, fixed risk after SL changes, intratrade versus realized drawdown, display extrema/gaps, StrictMode idempotence, restart and new-history reset. A StrictMode hook test compares every final execution and equity observation at 1×/10×/100×. Incremental chart/indicator results are compared with full causal calculations across partial candles, batches, flat stochastic windows and a weekend gap.

## CPU measurements

Run `node_modules/.bin/tsx scripts/replay-benchmark.mts`. Fixtures contain 1,440 / 43,200 / 129,600 M1 observations, without synthetic weekend removal, and eight subsequent 100-observation chart batches. Three panes use the incumbent M1/M5/H1 presets. The chart API is a sink in this benchmark, so these numbers exclude actual Lightweight Charts rendering.

Before changes, the production full-prefix path copied the revealed M1 prefix, aggregated all five timeframes and recalculated indicators for the three representative panes. Eight late-history samples averaged **4.60 / 65.62 / 192.26 ms** for 1 / 30 / 90 days respectively.

After changes, measured on this development host:

| Synthetic days | Initial aggregation/indicators ms | Mean 100-M1 chart batch ms | Max batch ms | All M1 execution + equity ms | Display sampling ms | Display points |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 14.15 | 2.99 | 10.08 | 10.80 | 0.42 | 1,440 |
| 30 | 122.02 | 0.87 | 1.12 | 76.92 | 7.41 | 1,426 |
| 90 | 293.58 | 0.92 | 1.13 | 108.81 | 12.48 | 1,436 |

Thirty- and ninety-day ordinary advances made **zero indicator `setData` calls**. The one-day fixture starts with H1 Ichimoku still warming, so its short projection/initialization series required ten replacements across the eight batches; it did not repeatedly replace historical price data. Initial settings/history installation and displaced timestamp realignment across gaps can also require replacement. The bounded dependency window and unchanged journal record references remove repeated historical calculation/render work. Measurements vary with JIT, hardware and other processes.

## Actual browser performance

Headless Chromium, 1440×1000, real Lightweight Charts, three panes, eight 100-observation advances. This includes incremental price/indicator series updates and chart synchronization. The two-frame measurement also includes waiting for two animation frames and paint scheduling, so it is not pure CPU time.

| Synthetic days | Initial setup + two frames ms | Mean batch work ms | Max batch work ms | Mean batch + two frames ms |
| --- | ---: | ---: | ---: | ---: |
| 1 | 151.10 | 10.50 | 17.40 | 88.55 |
| 30 | 475.10 | 75.62 | 100.30 | 157.45 |
| 90 | 995.20 | 228.36 | 309.60 | 412.98 |

**Remaining bottleneck:** Lightweight Charts series/time-scale updates dominate late multi-month replay. At 100× with three long histories, work can exceed the nominal 250 ms interval; the speed means observations per timer callback, not a guarantee of wall-clock throughput. Execution still processes all M1 candles. No candles or intrabar stop checks are dropped to improve these figures. Initial history/chart installation and display sampling remain proportional to dataset size. A temporary bounded-whitespace timeline experiment did not materially remove this renderer cost and was not included.

## Real provider and browser verification

Dukascopy retrieval used the configured local Chromium helper. The original running backend failed early pre-roll requests; a separate backend with `DUKASCOPY_CHROME_PATH` completed the same range.

- Selected **2024-01-01 through 2024-03-31**, 90 completed calendar days, plus pre-roll from 2023-12-02. Eighteen completed seven-day-or-shorter chunks returned **119,409 bid and 119,409 ask observations**, with **91,797** bid observations in the trading interval. First actual candle: 2023-12-03 22:00 UTC; final: 2024-03-29 20:59 UTC. No weekend candles were inserted.
- Provider/cache-population run took **537.82 seconds**. A subsequent real-browser 90-day load took **1.20 seconds** using the populated daily cache. This does not establish uncached performance for other networks or dates.
- Actual default H4 warm-up had **121 prior observations**, exceeding the required 78. The chart showed the causal projected cloud with no warm-up warning.
- A selected replay start at **2024-01-09 08:00 UTC** showed one tradable observation plus prior context. Automated chart tests separately assert the exact revealed price boundary on every timeframe.
- Real browser Play/Pause advanced at 1×, 10× and 100×; Next Candle, Restart and selected-start retention worked. Two positions were explicitly grouped into one setup and manually exited at different observations. Partial-setup scope showed no realized event; position scope showed one; completing the setup showed one combined setup event.
- A separate **2024-01-01 through 2024-01-31** range loaded successfully. Repeating it produced **zero additional browser history requests**.
- CSV export downloaded successfully; journal records, commission retention and clearing on Restart were checked.
- A deterministic browser fixture verified unrealized loss before closure, immediate entry fees, a missing ask mark without stale-price reuse, preserved SL coverage warning, and an automatic short stop during 100× playback. It retained 120 underlying M1 equity observations, including the unavailable one.
- Desktop **1440px** and mobile **390px** screenshots were inspected. No page-wide horizontal overflow or duplicate charts; journal tables scroll inside their own regions. No browser exceptions were recorded. The UI detector reported only the incumbent Inter font warning, retained to preserve styling.

## Limits of verification

Browser runs used desktop headless Chromium with viewport emulation, not a physical mobile device. Only sample playback intervals were inspected on real 90-day data; the complete all-speed execution equivalence check uses deterministic fixtures. The browser renderer benchmark does not guarantee 100× wall-clock throughput on slower devices. No tick paths, swaps, extra slippage, margin rules, account-currency conversion, compounding or persistence are modeled. Automated tests do not depend on provider availability.
