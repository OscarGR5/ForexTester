# Cache reuse and paid-download confirmation

Follow-up on PR #20, `feat/databento-history`, October 24, 2026. No PR was merged. Provider decoding, historical models, trading formulas, fingerprints and rollover execution remain unchanged.

## Persistent cache configuration

Inspected both cache roots before changes. The standard root initially contained only the existing Dukascopy directory; no conflicting Databento data or ledger existed. The offline migration copied and verified **241 files / 120 daily references** from `/home/admin/.cache/forextester-databento-verification-20261024/databento/` to `/home/admin/.cache/forextester/databento/`.

Normal Linux `npm run dev:backend` now finds that cache through its existing default. No environment override is required. No user sessions or verification sessions were migrated. The original cache remains an intact backup.

[Migration manifest](cache-migration.json) records SHA-256 for every file. The ledger hash is `6674d9f66239d853469e1c3b0999b35f6409c4fae766af9c75a2cae1c9b73460`. Both original reservations and their metrics remain byte-identical: **$0.805969089270 reserved, $4.194030910730 remaining of $5**. These figures describe the internal allowance, not current portal credits or measured billing. No credits, expiry or billing settings were invented or changed.

The migration utility acquires source and destination paid-work locks, verifies staged copies and every referenced history, validates the original ledger, then publishes without overwriting. Conflicting destinations, unexpected files and existing crash locks stop migration. Deterministic tests cover identical reruns, conflicting data/ledgers, malformed cache, test-session rejection and retained locks.

[Preservation evidence](cache-preservation.json) confirms all original verified-cache files, all 66 legacy cache files and all four durable user records are unchanged. The already-running development watcher refreshed its transient process `writer.lock` when source edits restarted it; that lock is excluded from durable-record comparison. Actual user sessions were not loaded, edited or deleted.

## Zero-cost normal startup

[Authentic Chromium evidence](cache-reuse-browser-verification.json) was measured using **`npm run dev:backend`**, the permanent default cache, no Databento variables and a preload tripwire blocking/logging any provider network attempt. Tests used isolated durable storage at `/home/admin/.local/share/forextester-cache-reuse-verification-fWd8FI/sessions`, separate from actual user sessions. Frontend Vite used an isolated port and proxy to the normal backend process.

| Check | Measured result |
| --- | --- |
| Selected replay | `[2024-01-01, 2024-03-31)` UTC, 90 dates |
| Included pre-roll | `[2023-12-02, 2024-01-01)`, 30 dates |
| Validated daily cache | 120 dates; no missing ranges |
| M1 observations | **110,383** |
| New download estimate / reservation | **$0 / $0** |
| Browser paid submissions | **0** |
| All provider network attempts | **0**, including metadata |
| Load, upload and durable save | **4,247.70 ms** |
| Original OHLCV and contracts | Deep equality against original cached history |
| Original history fingerprint | `d99322ad7a37c3652452c67cc2f45a6de0f120389471297c14129931cf6a6336` |
| Chart timeframes / pane counts | M1, M5, M15, H1, H4 / 1, 2, 3 |
| Replay / execution | Next observed M1 entry and manual close match exact original opens |
| Rollover | Stops before 6EH4 → 6EM4 with an open position retained |
| Refresh and backend restart without credentials | Exact trading, replay, equity and execution cursor restored |
| Chromium page errors / horizontal overflow | **0 / none**, 1440px and 390px |

The original mappings remain `6EZ3 / 306787` through December 18, `6EH4 / 156627` through March 18, then `6EM4 / 131197`. Dates are end exclusive. Unchanged timestamp gaps and original volume strings were included in the equality check.

For the UI, choose **From January 1 / Through March 30, 2024**. March 31 inclusive would make 91 days in leap-year 2024 and exceeds the existing 90-day limit. No request was made to extend the original cache.

Screenshots: [cached desktop Setup](cache-reuse-setup-cached-1440.png), [cached mobile Setup](cache-reuse-setup-cached-390.png), [desktop Trading](cache-reuse-trading-1440.png), [mobile Trading](cache-reuse-trading-390.png), [rollover](cache-reuse-rollover-block.png), [desktop Results](cache-reuse-results-1440.png), [mobile Results](cache-reuse-results-390.png).

## Paid approval and deterministic spending checks

The native dialog belongs to Setup. Fully cached dates load directly, without it. Partial and empty cache requests show calendar-date counts, expandable missing ranges, the prominent USD estimate, a clearly identified 2× internal reservation, remaining verification allowance, precise quote expiry and blockers. Approval requires acknowledgement that actual billing can differ. Cancel submits nothing and reserves nothing. Submitted requests show that closing or refreshing the page does not guarantee no charge.

Quotes bind to the validated content of every cached day as well as missing intervals. Any changed cache content, missing range, mapping, increased price or failed credit revalidation requires a fresh approval. Submissions consume the quote even when revalidation fails. Expiry is checked again after metadata revalidation. The persistent lock and ledger retain cross-process/restart protection; interrupted reservations and successful cached ranges survive later failure. No automatic paid retry was added. Replacement history is committed to React before a preserved session name can trigger an immediate autosave, preventing the old dataset from being assigned to the new session.

[Mocked GUI evidence](paid-confirmation-browser-verification.json) covers both 1440px and 390px: fully cached bypass; partial/empty coverage; missing-range expansion; prominent cost; Cancel and Escape; initial focus and native modal focus containment; accessible dialog and checkbox names; deliberate acknowledgement; quote expiry; changed-date approval invalidation; insufficient budget; repeated clicks submitting once; no horizontal overflow; no page errors or unexpected console errors. Expected `HEAD /api/storage/history/:id` 404 probes before initial upload are recorded separately in both browser reports; these are the existing storage existence check, not failed saves. The HTML now declares an empty favicon to prevent an unrelated missing-icon probe. Every history response was mocked and **zero history calls reached the real backend**.

Screenshots: [desktop paid dialog](paid-confirmation-1440.png), [mobile paid dialog](paid-confirmation-390.png), [mobile acknowledgement/actions](paid-confirmation-actions-390.png).

Service fixtures verify separated missing intervals, reuse after partial failure, preservation of uncertain reservations, concurrent services, restart rejection of old quotes, stale prices/credits, expiry during revalidation and cache-content changes with unchanged missing intervals. No real paid request was used for any spending test.

## Checks and limits

`npm test -- --maxWorkers=2`, `npm run typecheck`, `npm run build` and `git diff --check` pass. **513 tests across 40 files passed** in the final full run. The existing frontend chunk-size warning remains; no new dependency was added.

The design detector reported only the existing Inter font, which DESIGN.md explicitly requires. Native accessibility semantics and Chromium keyboard behavior were checked; a manual screen-reader session was not performed. Actual provider debits remain unobservable; the zero-cost result rests on zero new provider requests. Process crash locks still require manual review rather than automatic release. The existing rollover block remains; cross-contract carry/roll execution is outside this change.

Independent finish review:

| Verdict | Material findings |
| --- | --- |
| PASS | None |
