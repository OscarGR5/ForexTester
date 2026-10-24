# PR #19 validation review, October 24, 2026

**Recommendation: hold merge. Keep the current validation rule.** The seven March rows are not an extrema-only issue, and a further maximum-range attempt still could not complete. Before merging, demonstrate a complete 90-day selection plus 30-day pre-roll through load, save, refresh and storage restart on available data. Do not weaken validation merely to make that test pass.

Review starts at `ca4a61869ecac95a05b126898f4c2a84c05d9ecc`, the head of PR #19 targeting `feat/chart-first-ux`. This review changes tests, verification scripts and documentation only. It does not change backend/frontend admission rules, fingerprints, normalization, persistence, trading calculations or user datasets. Neither PR is merged.

## Original March observations

A read-only download of `https://candledata.fxcorporate.com/m1/EURUSD/2024/11.csv.gz` contained 7,183 rows and SHA-256 `f28880b660b009a22d8c0c6a324d53f7a0df3ae05ed4bdc56743f684121ba5c0`. The archive was not modified or installed in application storage. Exact decimal subtraction avoids floating-point cancellation when computing the differences below. EURUSD uses 0.0001 price units per pip; positive values mean the bid component exceeds its corresponding ask component. These are component differences, not proven simultaneous market spreads.

All timestamps are **March 12, 2024, UTC**:

| Timestamp | Crossed components and bid minus ask, pips |
|---|---|
| 12:32:00 | high +0.4; low +0.1 |
| 12:33:00 | close +0.4 |
| 12:34:00 | open +0.4; close +0.1 |
| 12:35:00 | open +0.1; close +0.1 |
| 12:36:00 | open +0.1 |
| 12:37:00 | low +0.2 |
| 12:42:00 | low +0.3 |

Seven distinct rows contain ten crossed components. Four rows have an open or close crossing; three have only high/low crossings. Sanitized UTC timestamps, fields, pip differences, file hash and download metadata are in [archive-audit.json](archive-audit.json). No original quote rows or full datasets are committed by this review.

## What the checks mean

For complete synchronized quote functions over one interval, if `bid(t) <= ask(t)` at every instant, both `max(bid) <= max(ask)` and `min(bid) <= min(ask)` follow. For the maximum, choose the instant at which bid attains its maximum; ask at that instant is at least that large, so the maximum ask is too. For the minimum, choose the instant at which ask attains its minimum; bid at that instant is no larger, so the minimum bid is no larger either. Different times for the two extrema do not invalidate either implication.

Comparing `BidHigh` with `AskLow` is different: those extrema can overlap during an ordinary moving market. The implementation does not compare those unrelated fields. A new regression test explicitly accepts such overlap.

Independently sampled or incompletely captured bid and ask series can violate the corresponding-component ordering without proving a genuine simultaneous negative spread. Independently sampled first/last ticks can also produce an open/close crossing if their quote times differ. These M1 rows contain one minute timestamp and no component-level quote timestamps, sampling provenance or synchronized tick sequence. They cannot distinguish true negative spreads, asynchronous sampling, source errors or aggregation defects. The observed 0.1–0.4 pip sizes alone do not resolve this uncertainty.

FXCM's [public archive documentation](https://github.com/fxcm/MarketData/blob/master/CandleData/README.md) identifies UTC indicative data and weekly files, but does not establish quote synchronization for these ten components. Its [historical candle API specification](https://fxcm-rest.readthedocs.io/en/latest/socketrestapispecs.html#historical-data) likewise exposes a candle timestamp and bid/ask OHLC fields, not the individual component quote times. These sources do not prove the March observations safe or prove that they represent simultaneous negative spreads.

ForexTester's existing engine pairs a bid candle with the ask candle at the same M1 timestamp and executes entries at the respective opens. Admitting an unexplained crossed open could therefore expose a paired negative opening spread to simulated execution. The unknown aggregation cause does not make this safe.

**Decision:** retain corresponding bid <= ask checks for all four components as a conservative FXCM dataset admission policy. It is not a universal claim that all independently sampled candles must satisfy the rule. Removing high/low checks would still leave four unsafe-to-admit rows and would accept other unexplained anomalies without new evidence. No epsilon, clamp, price substitution, row removal, gap filling or interpolation is introduced. Relaxation requires source-specific synchronization/aggregation evidence sufficient for this engine, or an explicitly approved different data policy; neither is available in this review.

Backend archive parsing and frontend parsing retain the same rule. Stored-history validation delegates to the frontend parser, so it retains the rule too. New deterministic tests isolate each of open, close, high and low crossings while keeping each side internally valid, and check rejection in all three paths without input mutation. Valid noncorresponding extrema overlap, equality of bid/ask prices, and exact preservation of values and gaps remain accepted.

## Fixed-budget May/June 2026 check

The complete read-only audit budget was **13 requests, zero retries**: the March archive, ten consecutive `2026/18` through `2026/27` filenames, and `2026/1` and `2026/37` controls. The ten candidate May/June filenames all returned HTTP 404. Both controls returned HTTP 200 with actual UTC observations in January 4–9 and September 13–18, 2026 respectively. No HTML response was treated as data or cached.

This is evidence against a small neighboring-week offset as the explanation. The checked range includes the known one-week shift and the adapter's neighboring candidate window around the initially missing May/early-June weeks. Working controls also argue against a blanket origin/network denial. **Probable classification: provider files unavailable at the documented endpoint within the tested filename neighborhood.** A distant/nonstandard mapping remains possible but unproven; no global inventory was performed. No discovery rule or production search budget changed.

## One different full-range Chromium attempt

`node --import tsx scripts/fxcm-review-browser.mts` selected **July 1–September 28, 2024 inclusive**: exactly 90 calendar days, API end September 29 exclusive, with 30-day pre-roll starting June 1. This is a different interval from both previous maximum-range failures and avoids the known March anomaly. It used real public FXCM data, sandboxed Chromium, the real Setup/loading workflow and backend, two frontend workers, and fresh temporary browser/cache/storage isolation.

The attempt stopped after **2,068 ms**: 12 API chunks completed, then chunks August 19–26 and August 26–September 2 failed with `FXCM_MISSING`. The loader's surfaced error identifies chunk 13/18. The complete dataset never became ready; Start remained disabled, no historical upload/checkpoint write occurred, and isolated durable storage contained zero sessions. This verifies rejection of the incomplete interval, not successful 120-day loading or storage performance.

Specific blocker: no matching published archive was found within bounded discovery for the required August 2024 chunk. Without a complete dataset, full-range upload, checkpoint, refresh and restart performance could not be measured. The review makes no assertion that every possible filename or provider delivery channel lacks that data. See [full-range-browser.json](full-range-browser.json) and [full-range-failure.png](full-range-failure.png). The harness includes load/save/restore/restart measurements for a successful run, but those branches were not reached and are not reported as verified.

All prior failed evidence remains unchanged, including the earlier 2026 404 attempt, the March 2024 validation failure and the original January/September successes. No production behavior changed, so a changed-validation browser verification is inapplicable. This new browser run verifies the unchanged missing-data rejection on a maximum-range attempt.

## Merge gate and checks

The January and September live successes and schema-1/schema-2 compatibility evidence remain valid. The application correctly refuses the newly examined incomplete intervals. The unresolved maximum-range loading/storage path prevents a positive merge-readiness recommendation from this review. A successful complete 90+30-day load/save/refresh/restart run is the concrete remaining gate; changing validation or searching indefinitely is not a substitute.

Final commands and results are recorded in [checks.json](checks.json). No production or financial algorithm files changed from `ca4a618`.

Final review checks: **569 tests passed in 41 files** with `npm test -- --reporter=dot --maxWorkers=2` (30.54 seconds). `npm run typecheck`, `npm run build`, and `git diff --check` passed. The six new validation regression cases also passed independently. Existing React `act` warnings and Vite's bundle-size advisory remain.
