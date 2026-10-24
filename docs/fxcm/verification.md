# Verification, October 24, 2026

Work starts from PR #18 head `f4ea330243fa17983749b8e99f0deb858781e6ec` on dedicated branch `feat/fxcm-history`. The PR targets `feat/chart-first-ux`. Neither PR is merged.

## Required live Chromium scenarios

`node --import tsx scripts/fxcm-live-browser.mts` uses the real React app, live backend and public FXCM endpoint, sandboxed Chromium, a new browser context, and freshly created external temporary cache/storage directories. Those directories are removed after the run. No real user backtests or durable storage are opened. Evidence: [live-verification.json](live-verification.json) and the January/September Setup, Trading and restored Results screenshots.

| Selected UTC period, inclusive | Trading candles per side | Total per side with 30-day pre-roll | Load time |
|---|---:|---:|---:|
| January 9, 2024 | 1,438 | 28,123 | 1,491 ms |
| September 17–24, 2026 | 8,628 | 40,183 | 880 ms |

The browser verified explicit FXCM selection, real rendered candlestick charts, play/pause and next-candle replay, both buy and sell entries, finish with two open positions, save, page refresh and restore. Each buy entry matched the original saved ask open at its execution timestamp; each sell entry matched the bid open. Restored checkpoints matched exactly and issued no history downloads. A subsequent new storage instance reopened and verified both saved datasets after the prior instance closed. There were zero page errors. Desktop 1440 px and mobile 390 px Setup had no horizontal document overflow.

January used actual archive `2024/2`; pre-roll included `2023/53`. September used `2026/37` and `2026/38` with pre-roll back to August 18. Full archive provenance is in the JSON, including hashes and observation bounds. Counts preserve the provider's missing minutes and holiday/weekend gaps.

These timings are observations from this machine and network, not throughput guarantees. They exclude initial page startup and the later disk save.

## Maximum-range attempts and limitations

The optional June 27–September 24, 2026 selection with May 28 pre-roll failed after 814 ms. Required May/June archives returned HTTP 404 within bounded discovery. The UI showed `FXCM_MISSING`, retained Setup, and disabled Start. Both verified saved sessions remained recoverable after this failure.

A separate fresh-cache maximum-range attempt, `node --import tsx scripts/fxcm-throughput.mts`, selected January 9–April 7, 2024 plus pre-roll from December 10, 2023. Thirteen chunks completed before validation rejected `2024/11.csv.gz`; the interval failed after 1,510 ms. Direct inspection found seven rows with corresponding bid prices above ask prices on March 12. No offending row was rewritten or excluded. The complete 120-day dataset was not published. See [throughput-verification.json](throughput-verification.json) and [archive-validation-observation.json](archive-validation-observation.json).

Full 90+30-day throughput is therefore **unverified**. The required January and September scenarios passed. The initial browser run treated the optional missing-data attempt as a failed assertion; [initial-live-verification.json](initial-live-verification.json) and [live-failure.png](live-failure.png) preserve its actual error. The final harness records the optional failure separately and completes restart recovery. No claim of universal FXCM availability or all-year filename mapping is made.

The first inspection of `2026/20` through `2026/25` returned 404. This is evidence only for those filenames, not proof that every possible archive for those dates is absent. Bounded discovery intentionally reports unavailable rather than searching indefinitely.

## Deterministic and compatibility checks

Tests cover explicit provider/default/unknown behavior, provider switches during and after loading, no late readiness from an aborted provider, separate caches, two workers, independent bid/ask preservation, year boundaries, shifted September filenames, partial weeks/closures/gaps, missing/unpublished archives, malformed gzip/CSV, invalid prices/OHLC, duplicate/conflicting and unordered observations, compressed/expanded size limits, download reuse/restart, concurrency limits and explicit retries.

Session tests cover both legacy record schemas in disk and IndexedDB, digest-preserving migration, recovery without network, schema-3 FXCM save/restart/restore, provider-pinned repair, immutable provider identity and rejection of cross-provider replacement. The v1 fingerprint golden fixture remains `8ffffddbe24baab6cb285bfb51b3df93e9a50faa09cc2c4c767902fa9fd74a04`. Existing execution, SL, sizing, commission, replay, indicator, equity and analytics tests run with the complete suite. Financial algorithm files have no diff from the base commit.

Typecheck, production build and diff checks are required for the final commit. The build retains the existing Vite bundle-size advisory. The UI detector reported only the existing Inter font, which DESIGN.md explicitly requires; that font was retained.

A default-concurrency full run hit the existing 5-second timeout in the computational `replayBars` indicator comparison while other checks were running. No assertion failed in that run. The final complete suite runs with two workers to avoid that contention; its result is recorded below.

Final checks: `npm test -- --reporter=dot --maxWorkers=2` passed **563 tests in 40 files** (33.82 seconds); `npm run typecheck`, `npm run build`, and `git diff --check` passed. The final live run also verifies that New session returns to Dukascopy and requires a fresh explicit FXCM selection.

## Follow-up review of ca4a618

The [PR #19 validation review](review/review.md) records the exact crossed UTC timestamps, fields and pip differences, assesses the independent-aggregation uncertainty, and retains validation unchanged. Four of the seven rows cross at open or close; this is not an extrema-only issue. A fixed 13-request audit found `2026/18`–`2026/27` unavailable while January/September controls worked. A different full 90+30-day Chromium attempt completed 12 chunks before missing August 2024 archives stopped loading; no dataset was installed or saved. Full-range storage performance remains unverified, and the merge recommendation is **hold pending one complete full-range load/save/refresh/restart verification**. Original failed evidence is preserved. Review-specific checks are in [review/checks.json](review/checks.json).
