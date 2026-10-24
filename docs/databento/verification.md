# Databento verification

The cache-reuse and paid-confirmation follow-up is recorded in [zero-cost startup and dialog verification](cache-reuse-verification.md). Normal startup now uses the migrated standard cache and original spending ledger.

Implemented from PR #18 head `f4ea330243fa17983749b8e99f0deb858781e6ec` on `feat/databento-history`, targeting `feat/chart-first-ux`. PR #19 / `feat/fxcm-history` was not incorporated, modified or removed. No actual user backtests, IndexedDB data, cache folders or repository branches were deleted or migrated.

Recommendation: merge-ready for the explicitly requested **replay block at rollover**, subject to project-lead review. Continuous trading across rollover remains unimplemented and requires a separate product decision. This PR makes no claim of verified carry/roll execution.

## Provider cleanup and configuration

Removed the `dukascopy-node` runtime dependency, provider browser/sandbox launcher and WAF bootstrapping, provider-only retries/diagnostics and tests, obsolete download scripts and browser harnesses that depended on the old provider acquisition/repair path. Their historical evidence remains in Git and under `docs/task-20/`. New Chromium verification replaces the obsolete acquisition harnesses; generic storage, cleanup, migration, execution and chart regression tests remain.

The Node/TypeScript backend uses documented Databento HTTP endpoints. JSON OHLCV decoding retains original prices, exact volume strings and instrument identity, without bid/ask duplication. UTC ranges, coverage, OHLC, record identity, volumes, order, duplicates and mappings are validated before ready data is persisted. No FXCM integration is included.

Configuration instructions are in [README](../../README.md) and [.env.example](../../.env.example). `DATABENTO_API_KEY` was loaded from the user-authorized private environment file exclusively into backend check processes. It was never printed, copied into a dataset, sent to the frontend or committed. The Chromium runner used an environment stripped of Databento variables.

The application blocks uncached downloads without current usable-credit evidence, a current quote, sufficient remaining $5 verification allowance, same-origin protection and explicit confirmation. The test runner used the user's confirmation of validity for the two specified ranges; it does not invent an account credit expiry date. No plan, licensing agreement, subscription or billing configuration was changed.

## Authenticated quotes, approval and spending

[Free authenticated metadata evidence](authenticated-metadata.json) verified `GLBX.MDP3` / `ohlcv-1m` availability from June 6, 2010. The selected symbol resolved to actual outright 6E contracts. Weekend request starts can return an interval beginning on the preceding trading date; the parser clips verified boundaries without filling mapping gaps.

| Request, UTC end exclusive | Quoted estimate |
| --- | ---: |
| January 9–11, 2024, two-day sample | $0.009930133820 |
| December 2, 2023–March 31, 2024, full 120 days | $0.402984544635 |
| Original combined approval | $0.412914678455 |
| Remaining full-range download after reusing the sample | $0.393054410815 |
| Cumulative submitted-download estimates | **$0.402984544635** |

The user confirmed the reported **$121.35** balance remained valid for these exact downloads and approved them before any paid request. The raw account expiry date remains unverified. The $5 test budget reserved **$0.805969089270**, twice the cumulative estimate, leaving **$4.194030910730**. The ledger persists across backend restarts and retains uncertain reservations. Estimates were refreshed before paid submission.

Three HTTP `timeseries.get_range` calls were needed: the small sample and two nonoverlapping remaining intervals. The full dataset reused the small sample rather than purchasing it twice. No paid request was submitted for rendering, performance reruns, refresh or restoration.

**Actual billed cost / exact credits debited are not observable in these streaming responses.** The submitted estimate is not a billing ceiling or a measured account debit. The [live evidence](live-verification.json) records `actualBilledUsd: null` rather than claiming an exact charge. No undocumented billing endpoint was used.

## Authentic datasets and performance

| Measurement | Small sample | Full sample |
| --- | ---: | ---: |
| Selected period | January 9–11, 2024 | January 1–March 31, 2024 |
| Full data boundaries | January 9–11 | December 2–March 31 |
| M1 candles | 2,720 | **110,383** |
| Internal missing-minute intervals | 37 | **2,187** |
| Missing minutes between first/last observations | 160 | **56,537** |
| Normalized JSON size | 332,080 bytes | **13,475,331 bytes** |
| Validated durable gzip history | Not a replay session | **1,132,368 bytes** |
| Download, validation and daily cache loading | 9.51 s | **120.28 s** |

The full 120-calendar-day grid contains 62,417 minutes without a record, including leading/trailing intervals. These counts include exchange closures and no-trade intervals. They do not establish that every absent minute is missing feed data. No price was interpolated or forward-filled.

Downloaded uncompressed JSON totaled **22,331,449 bytes**, including the sample; the remaining full-range calls transferred 6,566,254 and 15,215,027 bytes. Their measured streaming durations were 22.61 s and 85.26 s. The sample transferred 550,168 bytes in 4.70 s. Overall loading includes free revalidation and filesystem persistence, so it exceeds streaming duration.

Full aggregate counts: M1 **110,383**, M5 **22,598**, M15 **7,538**, H1 **1,886**, H4 **509**. All were constructed from unchanged trade OHLC. Charts expose only the revealed prefix within the current contract. Authenticated data does not imply all 120 days are tradable in one replay across a rollover.

The second real Chromium run loaded, uploaded and durably saved the cached full history in **4.50 s**. This is a local environment measurement, not a performance guarantee. The existing backend upload limit remains **64 MiB**. A separate deterministic test uploads and restores **172,800** dense M1 observations through the real HTTP history storage endpoint, exercising the largest 120-day storage path.

The validated full fingerprint is `d99322ad7a37c3652452c67cc2f45a6de0f120389471297c14129931cf6a6336`.

Data stays outside Git:

- Cache: `/home/admin/.cache/forextester-databento-verification-20261024/databento/`.
- Verification-only durable history: `/home/admin/.local/share/forextester-databento-verification-20261024/`.
- Chromium sessions: the isolated directory recorded in [browser evidence](browser-verification.json).

## Execution, indicators and rollover

New 6E backtests use one trade-price stream. Both entry directions and manual closes execute at the next eligible M1 opening. Long stops use low; short stops use high. Adverse opening gaps use the open. Same-entry-bar stops are allowed. Manual closes at an eligible open precede its intrabar range. No TP, synthetic spread or unavailable intrabar ordering is introduced. Two independent positions and configurable commissions remain. Sizing retains the clearly labeled hypothetical forex convention.

Deterministic tests cover long/short same-bar stops, missing candles, gap opens, next-open manual closes, independent positions, fees, state persistence, and engine rejection before a different contract can execute. StrictMode replay tests cover rollover blocking at **1×, 10× and 100×**, retaining two positions and the equity cursor.

[Offline authentic-data checks](offline-authentic-checks.json) additionally exercise both long/short same-bar stops and an actual gap-open stop using the already downloaded observations. No additional paid request was made. Independent calculations verify Bollinger, slow Stochastic and Ichimoku against the authentic same-contract M1/M5/M15/H1/H4 series. No formulas were changed to make those checks pass.

Verified mappings:

| UTC dates, end exclusive | Raw contract | Instrument ID |
| --- | --- | ---: |
| December 2–18, 2023 | 6EZ3 | 306787 |
| December 18, 2023–March 18, 2024 | 6EH4 | 156627 |
| March 18–31, 2024 | 6EM4 | 131197 |

The first switch falls inside pre-roll; the second falls in the selected period. Aggregate candles never mix contracts. Chart context and indicator warm-up reset to the current contract, so the prior contract's level jump is not an indicator observation. Replay blocks before the first new-contract M1 and clearly shows the reason. No stops, entries, manual exits, fees or equity observations execute across it. Unadjusted contract prices remain intact.

Outstanding product decision: whether any future workflow should close, carry, roll or separately restart positions at contract changes, and what executable price evidence would support it. The current safe block is implemented and tested; a complete cross-roll trading workflow is not.

## Saved-session compatibility and Chromium evidence

The legacy little-endian EURUSD/M1/v1 fingerprint path remains unchanged. Existing bid/ask datasets preserve both sides, independent gaps, old execution rules and v1/v2 checkpoint interpretation. Tests restore journals, orders, stops, fees, equity, chart settings and playback state without re-execution. Missing legacy data produces an original-dataset-required message; no replacement provider callback is invoked. Backup restores and optional IndexedDB migration retain original identities. Actual user backtests were not opened or edited for verification.

Real sandboxed Chromium used authentic cached data and isolated cache/session selection. It verified:

- Desktop 1440 px and mobile 390 px Setup, Trading and Results, with no document overflow.
- Fully cached status and $0 new-download cost; uncached quote/cancel/confirm behavior is tested deterministically.
- Rendering all five timeframes, all three chart-count choices and existing indicator presets.
- A next-observed-M1 entry and a next-open manual close checked against exact source prices.
- March rollover blocking with an open short retained and no synthetic close/stop.
- Save, refresh/resume, then backend restart **without credentials**, preserving exact trading state.
- **Zero paid download API calls** from the browser workflow and restoration; **zero page errors**.

[Setup with cache/cost](setup-cached-1440.png), [mobile Setup](setup-cached-390.png), [Trading](trading-1440.png), [mobile Trading](trading-390.png), [rollover block](rollover-block.png), [Results](results-1440.png), [mobile Results](results-390.png).

## Checks and limits

The complete suite, frontend/backend typecheck, production build and `git diff --check` pass; **501 tests across 39 files** passed. Use `npm test -- --maxWorkers=2` on this machine: unrestricted parallelism caused one existing indicator fixture to hit its five-second timeout under CPU contention. It passed with bounded workers; validation was not weakened. The build retains its existing warning about the frontend chunk exceeding 500 kB; no unrelated bundle redesign was added.

No automated claim is made about actual account debit, guaranteed billing ceilings, execution quality at a real venue, complete classification of source gaps, or carrying positions across rollover.
