# Historical date-selection correction

Follow-up to PR #20 head `01bb062`, October 24, 2026.

The cache-only coverage response incorrectly advertised the first cached day as the provider's earliest timestamp, with a selectable date 30 days later. The picker already ignored that limit for `cache-validated` responses, but the API contract was misleading and Setup required a nonempty earliest date to accept coverage.

Cache-only responses now return `null` for `providerEarliestTimestamp` and `earliestSelectableDate`. Validated cache bounds and counts remain in their separate `cachedFrom`, `cachedTo` and `cachedDates` fields. Setup accepts unknown provider dates, explains that additional data requires Databento access, and applies a historical minimum only when provider metadata establishes one. Completed-date and 90-day limits remain in place.

The acquisition path is unchanged: missing dates require authenticated availability, contract mapping and cost verification before explicit paid approval. Missing credentials block additional data with the existing configuration error. Fully cached requests remain free and offline.

## Verification

[Measured evidence](date-selection-verification.json) records:

- **515 tests across 40 files passed** with `npm test -- --maxWorkers=2`; typecheck, build and `git diff --check` passed.
- API and Setup regressions select January 3–4, 2022 before the December 2023 cache bounds, reach an exact missing-range estimate and approval, reject unapproved downloads, explain missing credentials, and still load the existing cached period for $0. The API test checks unchanged ledger bytes. Provider calls in these tests are fixtures.
- Chromium at **1440px and 390px** passed 16 mocked checks, including the earlier selection, acknowledgement gate, cancellation, expiry, budget blockers and duplicate-click protection. No mocked history request reached the real backend. No page errors, unexpected console errors or horizontal overflow occurred.
- The normal backend startup, with no credentials and provider traffic blocked, loaded **110,383 authentic candles** at a **$0 estimate and $0 new reservation**. Charts, fills, rollover blocking, refresh and backend restart retained their existing behavior and exact trading/replay/equity state. Zero paid submissions and zero provider network attempts occurred.
- SHA-256 comparisons confirm all 241 standard cache files, the original verification cache, 66 legacy cache files and four durable user records are unchanged. The existing development watcher's transient `writer.lock` is excluded. Test sessions use isolated storage.

Browser runners were executed with temporary copies changing only evidence output paths to `/tmp/date-selection-*`, preserving the earlier PR screenshots and reports. The committed confirmation runner now includes the cache-only coverage and earlier-date regression. The existing frontend bundle-size warning remains. No provider adapter, spending policy, trading calculation or rollover behavior changed. No PR was merged.
