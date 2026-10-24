# Task 20 verification

Verified on October 24, 2026, on the target Linux machine (Fedora 44, Node 24.18). This report distinguishes live provider checks from deterministic execution fixtures.

## PR #18 WAF reliability follow-up

**Provider reliability remains unresolved.** On October 24, 2026, fresh-cache tests on this same Fedora 44 / Node 24.18 machine reproduced upstream-facing **HTTP 503** failures, including during the installed library's token acquisition. January 9, 2024 also failed during this run. No complete live dataset was downloaded in these follow-up checks. The earlier successful January/February checks below remain historical evidence, not evidence that September 2026 works now.

### Live attempts

All ranges in this table have an inclusive start and **exclusive** end. Provider market-data and authorization caches were isolated outside the repository; temporary durable storage was separate from real saved backtests. Installed versions remain `dukascopy-node` **1.51.0** and its `playwright-core` **1.64.1**. No dependencies, browser installation, sandbox settings, provider scripts or credentials were changed.

| Path / UTC start | Period | Outcome | Elapsed |
| --- | --- | --- | --- |
| Baseline production `/api/history`, 13:58:14 | September 17–24, 2026 | HTTP 502, old `HISTORY_UNAVAILABLE`; Node transport saw seven HTTP 202 challenges, five HTTP 200 responses and five HTTP 503 responses before the failed API response | 55.367 s |
| Installed supported API, serialized, 13:59:56 | September 17–24, bid only | `WafTokenError`, `DUKASCOPY_WAF_TOKEN`; last browser status **503**, WAF action **none**, no cause provided | 61.127 s |
| Installed supported API, serialized, separate fresh cache | September 17–24, ask only | Same token acquisition error, browser **503**, action **none**, no cause provided | 60.955 s |
| Instrumented `/api/history` control, 14:02:52 | January 9–10, 2024 | Bid token acquisition failed with browser **503**; API now reports `PROVIDER_UNAVAILABLE`. Ask was not started after bid failed | 60.773 s |
| Actual React → production backend, 14:04:19 | Selected October 17, 2026; first pre-roll chunk September 17–24 | Normal two workers requested September 17–24 and September 24–October 1. Both failed with `WafTokenError`, browser **503**, action **none**; API returned HTTP 502 / `PROVIDER_UNAVAILABLE`. Setup identified chunk **1/6**, Retry stayed enabled, Start stayed disabled | 62.174 s to settled UI |

[Baseline API evidence](waf-baseline-api.json), [independent serialized bid/ask evidence and skipped controls](waf-direct-serialized.json), [January control](waf-api-january-control.json), [React evidence](waf-browser-verification.json). [Desktop error state](waf-setup-1440.png) and [mobile error state](waf-setup-390.png) show the real failure. Neither viewport had horizontal overflow, and the browser reported no page exceptions. The selected October 17 date reproduces the reported first September 17 pre-roll chunk; it does not claim to recover the user's otherwise unknown full selected interval.

The September 17 one-day control and February 5, 2024 older control were **not attempted** after the two direct authorization failures. Their bid/ask entries are explicitly marked skipped. One January API control then tested whether the previously working period still worked, followed by one normal React run to verify the actual application path and final error state. No Retry button was clicked during live testing. Further requests stopped after these checks; completing the remaining controls or proving successful September loading requires provider availability to recover.

### Established failure path and limits

In installed `dist/index.js`, `src/waf/browser-token.ts` begins at line **15764**. `acquireChromeSession` throws `WafTokenError` for unsupported Node, missing Playwright, launch failure, or failure to observe valid HTTP 200 JSON plus a provider authorization cookie. Its catch at line **15829** discards the original acquisition cause and reports only the last target-URL status and WAF action. The observed sanitized message was:

```text
Headless browser could not acquire a WAF token for [provider data URL] (last HTTP status: 503, WAF action: none)
```

There is no underlying `cause` on that installed error. The equivalent ESM implementation is in `dist/esm/chunk-IX7GKQR2.js`, with the final error message at line **15809**. `src/waf/index.ts` can additionally throw `WafTokenError` for an invalid acquired session. The inspected installed code, rather than older published retry guidance, determines the behavior described here. The [official retry documentation](https://www.dukascopy-node.app/errors-and-empty-data) covers the general retry options.

Sandboxed preflights succeeded in **0.723 s** for the serialized test and **0.515 s** for the January control. The subsequent 503 failures establish that browser launch success is insufficient. The first baseline request recovered far enough from the initial challenges to receive HTTP 200 provider responses, but later 503s prevented a complete response. Later attempts failed inside authorization itself. This is not evidence of missing browser libraries or a browser initialization failure.

**The reason Dukascopy returned 503 is not established.** The installed acquisition catch prevents inspecting a more precise cause. No HTTP 403 or 429 and no `Retry-After` were observed in the captured Node requests; the library exposes only the last browser status in its error. This does not rule out internal provider throttling, other unexposed browser responses or transient infrastructure faults. Both old and recent ranges failed, so a newer-period-specific explanation is unsupported.

### Scheduling and retry decision

The normal path retains two history workers, seven-day chunks and sequential bid then ask per chunk. The installed `batchSize` default is **10**, `pauseBetweenBatchesMs` is **1000**, generic `retryCount` is configured to **2**, and generic retry pause defaults to **500 ms**. The conservative direct test used one side at a time, `batchSize: 1`, `pauseBetweenBatchesMs: 1000` and `requestIntervalMs: 1000`. Both independent sides still failed. Concurrency is therefore not necessary to reproduce the error; these failed runs cannot quantify whether it contributes under otherwise healthy access. There is no measured benefit supporting a change to the two-worker default.

The package already has a separate **three-retry** HTTP 429 budget with waits starting at **5, 10, 20 seconds** plus jitter and support for the longer `Retry-After` delay. A requested wait over five minutes stops the operation instead of being shortened. `WafTokenError`, `WafChallengeError` and exhausted `RateLimitError` bypass ordinary `retryCount` retries. Token acquisition is coordinated within one library fetcher, but separate `getHistoricalRates` calls create separate fetchers; the supported configuration does not expose shared acquisition state between those calls. No private transport or token coordination was introduced.

**No additional automatic authorization retry/backoff was added.** Live tests demonstrated persistent 503 failures, not recoverable HTTP 429 throttling. Wrapping the existing retry budget in another automatic loop would add requests without demonstrated benefit. An explicit Retry retains completed frontend chunks and the existing provider disk cache. If a known rate limit is exhausted, the API sends HTTP 429, preserves `retryAfterMs` and a rounded-up `Retry-After` header, and the GUI explains the minimum wait without promising the next attempt will succeed. Existing completed-chunk progress and failed-chunk identity remain available. There is no newly introduced automatic retry timer whose progress needs streaming.

### Changes and deterministic verification

Backend classification now examines bounded cause chains, recognized error names/codes and available HTTP status before falling back to a generic result. Browser installation/dependency errors, authorization, unchallenged HTTP 403 denial, rate limits, HTTP 5xx availability and network errors have distinct results. In particular, a token acquisition error whose last browser status is 503 becomes `PROVIDER_UNAVAILABLE`, not an unsupported diagnosis that authorization or Chromium installation alone is at fault. Provider retrieval wraps the original cause with the failing bid/ask side. Browser preflight retains its original cause too.

Backend logs now allowlist dates, error classification, side, known names/codes, status and WAF action. They never dump upstream errors, stacks, arbitrary cause properties, request headers, cookies or tokens. Typed frontend errors preserve the title, code and delay through chunk failure; the first worker's error is not overwritten by a later worker failure. Setup shows a focused title and explicit Retry. Browser setup instructions appear only for browser errors or an unclassified local validation error. GUI-to-backend connectivity failure has its own `BACKEND_NETWORK` diagnosis.

`npm test` passed **38 files / 512 tests**. `npm run typecheck`, `npm run build` and `git diff --check` passed. The existing bundle-size warning remains. The Impeccable detector returned no findings for the changed production frontend files; real desktop/mobile error states were inspected together.

| Requested deterministic case | Evidence |
| --- | --- |
| Transient authorization failure followed by success | `historyLoader.test.ts`: explicit Retry succeeds and completed chunks are fetched once |
| Persistent authorization failure / bounded attempts | `historyLoader.test.ts`: at most the two in-flight frontend workers, no automatic repeated authorization; `providerRetries.test.ts`: installed package does not retry `WafTokenError` through generic `retryCount` |
| Rate-limited responses | `providerRetries.test.ts`: real installed `BufferFetcher` with mocked HTTP transport, 12-second `Retry-After`, success, four-attempt exhaustion and refusal to shorten a 600-second delay; API/header and frontend metadata tests |
| Browser launch versus WAF failure | Actual invalid-executable preflight, sandbox wrapper test, structured and nested classification cases |
| Partial successful chunks followed by retry | `historyLoader.test.ts`: validated successful chunks survive explicit retry; distinct original ask prices remain distinct |
| Cancellation during retry delay | `historyLoader.test.ts`: modeled pending HTTP response during provider backoff aborts promptly and leaves no frontend test timers; actual installed server-side provider work remains uncancellable through its public API |
| Simultaneous bid/ask handling | `history.test.ts`: two concurrent callers retain independent sides with bid before ask per caller; `app.test.ts`: ask authorization failure never publishes bid-only success |
| Error classification and secret safety | `historyCoverage.test.ts`, `app.test.ts`, `history.test.ts`, `workflow.test.tsx`: nested causes, HTTP 429/403/503, WAF, network, browser, unrelated token-named errors, cyclic causes and secret-bearing errors |
| No duplicate or conflicting candles | Existing normalization/merge tests plus retry uniqueness checks |
| Saved-backtest regression | Full suite including filesystem recovery, migration, historical fingerprint repair, replay and trading tests |

No candle normalization, observations, gaps, fingerprints, persistence schema, saved backtest, trading/execution rules, seven-day boundaries, 30-day pre-roll or 90-day selected interval changed. No partial failed interval is installed as ready. No WAF protection was bypassed, sandbox disabled, identity rotated or provider replaced. **Successful September 2026 loading remains unverified. PR #18 remains open and unmerged.**

Reproduction scripts are diagnostic, not success assertions. They record failure outcomes and stop the direct matrix after two authorization failures. Run them again only after provider availability has recovered:

```sh
WAF_MODE=direct WAF_SERIALIZED=1 node --import tsx scripts/verify-provider-waf.mts
WAF_FROM=2024-01-09 WAF_TO=2024-01-10 WAF_EVIDENCE=/tmp/provider-control.json node --import tsx scripts/verify-provider-waf.mts
node --import tsx scripts/verify-provider-waf-browser.mts
```

## UX and screenshots

[Annotated wireframes and transitions](design.md) describe Setup → Trading → Finished. Setup requires an explicit download; Trading mounts the chart stack and compact dock; Finished mounts Overview, Journal, or Equity & drawdown. Administration lives in a modal. Account PnL uses current ledger equity minus starting balance, including incurred fees, with an unavailable state for missing required quotes.

| Before | After |
| --- | --- |
| [Original long page](before.png) | [Setup](setup-1440.png), [Trading with real Dukascopy history](trading-live.png), [Results](results-1440.png) |

![Setup at 1440 × 900](setup-1440.png)
![Trading with real historical observations at 1440 × 900](trading-live.png)
![Results at 1440 × 900](results-1440.png)

Additional captures: [1728 setup](setup-1728.png), [1728 trading](trading-1728.png), [1728 results](results-1728.png), [mobile setup](setup-390.png), [mobile trading](trading-390.png), [mobile results](results-390.png), [two charts](trading-2-charts.png), [three charts with indicators](trading-3-charts.png), [equity and drawdown](results-equity.png). Fixture screenshots use synthetic prices to make stop execution reproducible; the real-history screenshot is separately identified.

Measured with two open positions and the dock visible:

| Viewport | Chart canvas | Actual price plot | Canvas / viewport height | Price / viewport height |
| --- | --- | --- | --- | --- |
| 1440 × 900 | 1424 × 652 px | 1358 × 624 px | 72.44% | 69.33% |
| 1728 × 864 | 1712 × 616 px | 1646 × 588 px | 71.30% | 68.06% |
| 390 × 844 | 390 × 368 px | 324 × 340 px | 43.60% | 40.28% |

The canvas occupies 77.07% / 76.05% of desktop height after the 54 px application header. Price plot measurements exclude time and price axes. Mobile deliberately scrolls vertically to preserve a usable chart. No page-wide horizontal overflow was found at the three requested sizes. Three stacked charts share the workspace, including Stochastic, without the old pane minimum heights pushing charts over one another.

The independent finish review returned **Pass**. Both findings were resolved: mobile trading input sizes are 16 px, and the starting-balance accessible name matches its visible label. The harness did not expose the named Impeccable reviewer/documenter roles, so fresh agents performed those scoped handoffs using the skill references.

## PR #18 initial viewport fix

`ChartSynchronizer.initializeViewport()` now uses up to 200 observed candles on the first populated chart, anchored to the revealed replay edge. Observed timestamps account for weekends and missing minutes. Standalone M1, M5, M15 and H1 start with 200 candles when available; H4 uses up to 200, which was 123 with this real 30-day pre-roll. Mixed layouts retain one shared UTC horizon chosen by their first populated chart. Adding a pane or changing its timeframe preserves that horizon. A saved custom viewport takes precedence, including its following preference; following restores retain the saved width at the recovered replay edge.

The updated [fresh M1 screenshot](trading-live.png) is captured at 1440 × 900 without wheel zoom. Real Dukascopy EURUSD history for January 9, 2024, with the preceding warm-up, installs **27,712 revealed M1 candles** and initially displays **200**. Horizontal spacing is **6.79 px**; 164 visible bodies measure at least 2 px vertically and 184 visible high/low spans measure at least 4 px. Older prices remain reachable, including the earliest installed candle. [Mixed M5/M15/H4](trading-viewport-mixed.png) retains Ichimoku forward projection; [restored custom navigation](trading-viewport-restored.png) retains the exact saved UTC range with following disabled.

[Viewport browser evidence](viewport-live-verification.json) records every standalone timeframe, three-chart synchronization, public wheel zoom/drag navigation, follow-replay, a manual viewport held through replay and reload, restoration without another history request, and zero unrevealed price candles or page exceptions. It distinguishes forward indicator points from future OHLC. The verification server exposes chart API handles through a test-only Vite transform; production code gains no debug interface. Sessions use an isolated temporary directory. The provider cache may reuse downloaded history.

Reproduce with `node --import tsx scripts/task20-viewport-browser.mts`. `REPRESENTATIVE=1` selects deterministic weekday history with a 30-day warm-up instead of the provider. The earlier `task20-live-browser.mts` also captures the default viewport without applying manual zoom now.

Fifteen added unit cases cover initial ranges on all five timeframes, partial buckets, weekends, short history, delayed data installation, remount/timeframe stability, three mixed layouts, full-history navigation, follow-replay, projection and saved custom ranges. The existing synchronization assertions remain, with the navigation-only call count reset after the newly necessary initial zoom.

The late 90-day Task 19 isolated three-chart benchmark was rerun using `DIRECT_ONLY=1 DAYS=90 SCENARIO=D node --import tsx scripts/chart-replay-browser.mts viewport-fix-late`: 12 batches of 100 M1 observations, **61.42 ms mean / 81.50 ms p95** synchronous JavaScript with the pointer over chart 1. [Performance evidence](viewport-performance-verification.json) records incremental candle/indicator updates, no `candles.setData` calls during measured playback, and no browser errors. This is a local smoke check, not a new throughput guarantee. The production diff changes only initial viewport selection; execution, financial calculations, persistence schemas, underlying prices and indicator warm-up remain unchanged.

`npm test` passed **37 files / 486 tests**. Typecheck, build and diff validation passed. An initial concurrent test/build/browser run timed out one existing indicator-reference test at 5 seconds; the subsequent full test run passed without competing build/browser work. The existing bundle-size warning remains.

## Live provider verification

Installed `dukascopy-node` is 1.51.0 and its `playwright-core` is 1.64.1. `npx dukascopy-node --install-browser` completed successfully, installing regular Chromium revision 1248 through the Ubuntu 24.04 fallback build. The old installed revision alone was insufficient. Existing Linux libraries were sufficient; `--with-deps` was investigated but no privileged packages were installed.

The backend performs a sandboxed launch preflight using the provider's own Playwright. On Linux an executable wrapper removes upstream sandbox-disabling flags. Sandbox failure remains a failure. `DUKASCOPY_CHROME_PATH` selects a configured executable through the same wrapper. The library's WAF flow is unchanged; there is no access-protection bypass. Seven-day chunks, two concurrent workers and the XDG cache remain intact.

The first cold request completed in 20.390 seconds and the second in 37.648 seconds. The live API script starts a fresh backend and immediately requests January 9, 2024, then a second range, February 5–6. Both bid and ask arrays are nonempty with original OHLC values. [Provider evidence](provider-verification.json) records counts, timings, sample prices and resulting coverage. The final run uses a fresh external temporary cache, so these are network downloads rather than fixture or cached-only success.

| Inclusive selected period | Bid M1 observations | Ask M1 observations |
| --- | --- | --- |
| January 9, 2024 | 1,438 | 1,438 |
| February 5–6, 2024 | 2,873 | 2,873 |

[Live browser evidence](live-browser-verification.json) also records successful real React → backend → provider loading of January 9 plus its 30-day pre-roll: six successful chunk responses, sandbox enabled, no browser exceptions. [Loaded setup](setup-live.png) and [trading](trading-live.png) are screenshots from that run. Its cache may reuse earlier successful downloads; the fresh-cache API run above establishes cold startup behavior separately.

Coverage reads `instrumentMetaData.eurusd.startDayForMinuteCandles`. Installed metadata is **2003-05-04 19:00 UTC**, while the [published EURUSD page](https://www.dukascopy-node.app/instrument/eurusd) lists **21:00 UTC**. The endpoint reports the installed value; both imply May 4 as the first selectable calendar date. The latest completed UTC date is provisional, and last verified date means a date with observed synchronized bid/ask data in this backend process, not full-day completeness. Browser launch, missing libraries, WAF, network, temporary data and invalid-range failures have distinct sanitized codes/messages/actions.

## Execution and recovery

Chart placement uses public crosshair/click events and candlestick `coordinateToPrice`. Only pane 0 accepts placement. The clicked candle's time and historical price are irrelevant. Hover previews a line; click selects; confirmation queues the existing execution request. Risk preview uses observed prices, and the engine sizes risk orders again at the future synchronized M1 opening. Escape, replay start, restart and session switch discard drafts.

The Chromium fixture run created two Buy entries in one setup with separate chart-selected SLs, modified the first through the chart, stopped only that entry, manually closed the other, then entered and manually closed a Sell. [Downloaded CSV, with line endings normalized for Git](browser-journal.csv) preserves the execution evidence:

| Position | Lots | Initial SL | Final SL | Exit | Net USD |
| --- | --- | --- | --- | --- | --- |
| 2-1 Buy | 0.69 | 1.09896 | 1.09925 | Automatic stop | -84.18 |
| 2-2 Buy | 0.42 | 1.09804 | 1.09804 | Manual | -11.34 |
| 2-3 Sell | 0.68 | 1.10165 | 1.10165 | Manual | -18.36 |

Finish pauses and saves before confirmation, discloses open/pending counts, and persists Finished without inventing exits. A failed finished checkpoint returns to Trading. Notes stay editable in Results. Schema 2 adds lifecycle; valid schema-1 digests are checked before mapping unstarted → Setup, started → Trading, complete → Finished. Financial state, history fingerprints, exclusive ranges and equity chunks remain intact. Restores pause active sessions and reopen finished Results without downloading a valid saved dataset. Draft stops are never serialized.

## Automated checks

`npm test`: **37 files, 486 tests passed**, including the startup and initial-viewport regressions. `npm run typecheck`, `npm run build`, and `git diff --check` passed. Build retains the existing large-bundle warning; no runtime dependency was added.

All prior regression assertions remain. The 61 legacy `App.interaction.test.tsx` cases use an explicitly test-only `RegressionWorkspace` composition of the former controls with current production chart, replay, trading, journal and persistence components. They do not claim to validate new navigation. `workflow.test.tsx` tests the production three-phase App under StrictMode, and Chromium scripts exercise the real new UI and Lightweight Charts.

Acceptance-test mapping:

| Requested cases | Evidence |
| --- | --- |
| 1–6 setup, no download, coverage, bounds, inclusive conversion, invalid ranges | `workflow.test.tsx`, `historyCoverage.test.ts`, `history.test.ts`, `app.test.ts` |
| 7–9 provider errors, classification, retry | `historyCoverage.test.ts`, `providerBrowser.test.ts`, `historyLoader.test.ts`, production workflow error/retry tests |
| 10–14 account setup/lock, chart workspace, USD/% PnL and missing quotes | `workflow.test.tsx`, `equity.test.ts`, Chromium layouts |
| 15–22 Buy/Sell, side validation, oscillator rejection, cancellation, confirmation, independent stops | Production workflow tests and Chromium chart clicks on every timeframe |
| 23–30 risk cap, bid/ask fills, close, stops, modifications/history, paused-only requests, draft cleanup | `trading.test.ts`, `risk.test.ts`, `stopLoss.test.ts`, `setupGrouping.test.ts`, production workflow and Chromium |
| 31–38 finish, results visibility, financial statistics, migration/recovery, CSV | Production workflow, `analytics.test.ts`, `commissions.test.ts`, equity/recovery/migration tests, `journalCsv.test.ts`, Chromium finished refresh and downloaded CSV |
| 39–42 layouts, synchronization, no lookahead, StrictMode | Chromium 1/2/3 layouts, real crosshair/viewport checks, `chartSync.test.ts`, `replayBars.test.ts`, existing regression composition and production workflow |

[Browser results and dimensions](browser-verification.json) record zero page exceptions. The script also confirms oscillator-pane clicks do not select an SL, chart clicks alone do not queue an order, every available timeframe accepts price placement, the journal is absent during Trading, notes save after finishing, and finished restore makes no history request.

## Reproduce and limitations

### Refresh with older browser sessions

A reported refresh bug exposed Setup briefly, then forced the migration drawer when only an older IndexedDB backtest existed. Discovery now shows a short loading state; legacy-only discovery leaves Setup usable with an optional **Review browser backtests** action. Disk sessions still receive the existing session-selection flow. No browser record is deleted or imported automatically.

`node --import tsx scripts/task20-startup-browser.mts` seeds an isolated browser session, delays discovery, refreshes twice, checks Setup stays available without a modal or download, opens/closes migration, and imports the original successfully. [Browser evidence](startup-verification.json), [desktop](startup-legacy-1440.png), and [mobile](startup-legacy-390.png) captures verify the reported case. Production StrictMode regression coverage also checks the original digest is unchanged.

Commands and browser setup are in the [README](../../README.md#repeatable-dukascopy-browser-setup-on-linux). Scripts use isolated temporary session directories, leaving real backtests untouched. Live scripts require network/provider availability. They use verification tooling already available in the local environment (`tsx`, `playwright-core`) rather than adding production dependencies.

Before the first successful load, setup fields remain an unsaved draft. Loaded Setup, Trading and Finished checkpoints are durable. Cancel aborts frontend requests and ignores obsolete responses; the provider library cannot cancel work already running on the server, which may finish filling its cache. Provider metadata and newest-day uploads can differ; calendar eligibility never proves observations exist. Native date fields support direct year editing, with appearance depending on the user's browser. Browser measurements are local Linux Chromium results, not a guarantee for every device or browser. No financial formulas, execution assumptions, automated strategies, signals or take-profit functionality were introduced.
