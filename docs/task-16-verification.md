# Task 16 verification

Verified October 23, 2026. Base: `6d395a8` (`main`, merged PR #13). Branch: `feat/session-persistence`.

## Files and implementation

| Area | Files |
| --- | --- |
| Schema, validation, history identity, IndexedDB | `frontend/src/sessionTypes.ts`, `sessionCodec.ts`, `sessionStore.ts` |
| Autosave scheduling and session lifecycle | `frontend/src/autosave.ts`, `useSessionPersistence.ts` |
| Session controls and workspace integration | `frontend/src/SessionControls.tsx`, `App.tsx`, `style.css` |
| Direct paused hydration and execution cursor | `frontend/src/useReplay.ts`, `useTrading.ts` |
| Horizontal viewport and controlled journal scopes | `frontend/src/chartSync.ts`, `TradingJournal.tsx` |
| Deterministic fixtures and regression tests | `frontend/src/sessionFixtures.ts`, `sessionStore.test.ts`, `sessionRecovery.test.tsx`, `autosave.test.tsx`, `SessionControls.test.tsx`, `App.interaction.test.tsx` |
| Test environment | Root `package.json`, `package-lock.json`; `frontend/tsconfig.json` |
| Documentation and reproducible CPU benchmark | `README.md`, `docs/session-persistence.md`, this report, `scripts/session-benchmark.mts` |

No production dependencies were added. `fake-indexeddb` is development-only; frontend typechecking now includes Node types for test-side crypto/timer imports. Backend routes, price execution assumptions, risk formulas, commissions, stops, analytics, and equity formulas are unchanged. All trading remains discretionary except the existing SL execution.

## Storage and consistency

Database `forextester-sessions` version 1 contains `sessions`, `equity` and `history`. Sessions have UUIDs, explicit UTC metadata, schema versions, monotonically checked revisions and SHA-256 checkpoint digests. Equity uses ordered, individually hashed **1,024-observation** chunks. History is separately cached once under a canonical fingerprint containing every validated bid/ask value, side membership and date bounds.

A save walks only the unsaved ledger suffix plus at most one partial chunk. It never recursively serializes the linked chain, rewrites unchanged full chunks, or recalculates equity from candles. Checkpoint and changed chunks commit in one transaction after checking the expected revision. Aborts retain the previous complete revision. A smaller trading checkpoint commits before the large cache write; cache quota failure leaves a visible recovery limitation rather than misreporting checkpoint failure.

Manual actions, paused steps and UI changes use a 150 ms queued save. Running replay uses roughly five-second checkpoints. Writes are serialized/coalesced and page hiding attempts a flush. Save now uses the same queue. Status and last-save time update only after successful commit; queued work is marked Saving.

Recovery reads checkpoint/chunks/cache in one snapshot transaction, verifies checksums and essential execution/accounting/UI invariants, reconstructs the ledger iteratively and verifies its summary. The recovered history must match the saved fingerprint and all cursor/equity timestamps. Replay, engine, ledger and UI settings hydrate together with playback paused. The saved cursor excludes accounted-for observations, so only N+1 is processed next. Pending orders and closes remain pending until an eligible later opening.

Missing/damaged history is redownloaded with a fresh instance of the existing two-worker seven-day chunk loader. A changed dataset stops recovery and leaves stored trades untouched. Revision checks protect saves, rename and delete even without BroadcastChannel; broadcasts also pause a stale active tab. Unsupported schemas/databases and corrupt records are preserved for retry or explicit deletion. Metadata rendering has runtime guards, including for malformed counts and dates.

New/date-change/switch operations save the previous workspace before changing it. Save failure stops the switch. Restart requires confirmation when trading/journal records exist, explaining the overwrite and New session alternative. Delete requires confirmation. Final-candle sessions retain open positions, pending orders, notes and exports. Shared history is retained while another session references it.

## Automated checks

`npm run typecheck`, `npm run build`, `npm test` and `git diff --check` passed. The build emitted a non-failing size warning for the 503.37 KB minified JavaScript bundle (157.63 KB gzip). The final suite has **334 tests across 24 files**. All automated fixtures are deterministic and require no Dukascopy access.

The new coverage includes creation/UTC metadata/progress; paused and previously playing hydration; completion/final candle; independent sessions; rename/delete; account, cap and commission settings; pending risk/manual entries and manual closes; two independent positions and two entries in one setup; metadata after closure; SL and quote-coverage histories; original risk; gross/net PnL; same-candle stops; exact cash/fees; high-water marks/drawdown/missing observations; a 129,600-point ledger; unchanged-chunk write counts; batching/prompt/pause/hidden-page saving; failed/interrupted read and write transactions; quota and history-cache quota; corrupt snapshots/metadata; unknown schema/database versions; fingerprint mismatch and missing-cache redownload; stale save/rename/delete without broadcasts; StrictMode; restart confirmation; previous-session preservation on date changes; chart/indicator/scopes; and CSV after recovery.

A StrictMode hook comparison restores at observation 21 and completes at **1×, 10× and 100×**, comparing the entire engine state, every equity point, cash, fees and CSV against uninterrupted execution. Separate tests verify pending entry/close execution at N+1 and final-history open-position preservation. Application tests refresh the mounted workspace using the real IndexedDB adapter, compare records/settings, continue a close, reject Restart on cancellation, and retain separate historical sessions.

## Chromium verification

Used real headless Chromium and Lightweight Charts at **1440×1000** and **390×844**. Historical responses came from the validated real Dukascopy capture produced in Task 15, served locally through the unchanged seven-day request shapes. The 90-day interval was **2024-01-01 through 2024-03-31**, with 30-day pre-roll and **119,409 bid plus 119,409 ask** observations. A second interval used **2024-01-15 through 2024-01-31**. This run did not perform a fresh upstream Dukascopy download.

- Named the 90-day backtest; set a $10,000 reference balance, 5% combined cap and $7 round-trip commission; grouped two 0.1-lot buys; changed one SL; closed one entry; wrote title, tag and multiline notes; selected three charts and a custom M15 Bollinger length; changed both scopes and speed.
- Saved, refreshed and resumed. Compared **all underlying engine fields**, equity summary, indicators, account/commission settings, scopes, visible position records and UTC replay timestamp. Recovery was paused and revealed the saved prefix.
- Closed the remaining position at the next bid open. Both trades remained unique; total fees were $1.40 and final cash reconciled to **$10,000.00** for this price path. Notes remained editable after closure. Downloaded the recovered journal CSV.
- Removed the history cache and recovered through chunked downloads. Then changed a historical candle in the download: recovery stopped with an explicit fingerprint conflict and the original two closed trades remained stored. Retrying with matching history succeeded.
- Injected a real browser `QuotaExceededError` into the session write. The visible error appeared and the previous revision/save time stayed authoritative. Removing the injected failure allowed Save now to commit.
- Created a separate historical session, switched both directions, and checked independent trades, clocks and settings. Refreshed during 100× playback and recovered its committed cursor paused. Refreshed **230 ms after** submitting a pending entry and recovered that entry.
- Completed a separate session near the dataset end with a position still open, refreshed and recovered Complete without forcing an exit. A second tab saved a newer revision; the original tab paused with a visible conflict and editing disabled.
- No page-wide horizontal overflow at either viewport. No page exceptions were recorded. Browser storage estimate for the four saved real-data sessions (including the initial default viewer session) was **8,945,941 bytes**, quota approximately **3.23 GB** in this temporary profile.

A production-build Chromium smoke test also saved an open position, refreshed, resumed paused and retained its exact entry/SL/volume/clock.

The bounded UI finish review passed after fixing malformed list-count rendering. The mechanical detector reported only the incumbent Inter font warning, retained to preserve the established interface.

## Performance and storage

Measurements are samples on this development host, not timing guarantees. `node_modules/.bin/tsx scripts/session-benchmark.mts` reproduces the Node/fake-indexeddb fixture; browser measurements used actual IndexedDB in Chromium. Synthetic history contained 129,600 chronological M1 observations per side and 100 closed positions. Restore timings include cached history validation/fingerprinting, chunk checking and iterative ledger installation, but exclude React/chart paint.

| Operation | Chromium actual IndexedDB | Node + fake-indexeddb |
| --- | ---: | ---: |
| Initial save, 100 closed positions and 201 equity points | 8.50 ms | 17.14 ms |
| Restore those 100 positions with the full history cache | 253.60 ms | 400.70 ms |
| Cache full bid/ask history once | 200.20 ms | 306.22 ms |
| Fingerprint full history | 55.10 ms | 82.86 ms |
| Save checkpoint growing to 127,600 equity points | 211.90 ms | 432.07 ms |
| Restore 129,600 equity points plus 100 closed positions | **466.00 ms** | 705.08 ms |
| Incremental checkpoint, 2,000 new points | **8.90 ms** | 12.28 ms |
| Process those 2,000 engine/equity events | 0.80 ms | 1.47 ms |
| Checkpoint with no new equity | 4.50 ms | Not separately timed |

Logical JSON sizes were **97,474 bytes** for the final browser checkpoint, **27,087,881 bytes** for all flat equity points, and **22,835,638 bytes** for both candle sides. Actual reported IndexedDB usage was **4,862,164 bytes** for the benchmark origin at measurement time. Browser storage estimates are approximate and browser storage compression makes repeated synthetic values much smaller than their logical JSON representation; do not treat these numbers as quota projections for arbitrary real data.

Chunk-size comparison over the same 129,600 observations:

| Chunk size | Number of chunks | Encode one tail chunk | Tail JSON bytes |
| --- | ---: | ---: | ---: |
| 256 | 507 | 0.21 ms | 53,505 |
| **1,024** | **127** | **0.59 ms** | **214,017** |
| 4,096 | 32 | 2.80 ms | 856,065 |

The chosen size bounds partial-chunk rewrites to about 214 KB in this fixture while requiring one quarter as many records as size 256. A deterministic write-count test confirms that advancing from 129,001 to 129,600 points writes two changed chunks and one checkpoint, not all 127 chunks.

A separate real-data browser run used the late 90-day history, three charts and 100× playback. It advanced **2,500 M1 observations** and ended paused with **2,501** equity points. Two running checkpoints completed in **1,625.0 ms** and **1,546.6 ms** elapsed; the pause checkpoint completed in **11.6 ms**. Time spent in the initial synchronous save call before its first asynchronous yield was **1.5 / 1.0 / 0.8 ms**, respectively. This measures only the initial synchronous segment, not all later callback work. The elapsed save time includes scheduling delays while charts render and is not evidence of 1.6 seconds of blocking persistence work. No browser exceptions occurred.

The rendering bottleneck still prevents nominal 100× wall-clock throughput. These samples establish small initial save work and incremental writes, but they do **not** isolate total persistence CPU overhead from chart/render scheduling or prove unchanged end-to-end replay throughput. The last successful checkpoint can lag while a write waits to commit.

## Limits

Browser verification used desktop headless Chromium with viewport emulation, not physical mobile hardware or other browsers. Full real-data multi-month playback was sampled rather than completed at every speed; complete speed equivalence uses deterministic fixtures. The real-data recovery path used a captured provider dataset, not fresh live network retrieval. An injected storage exception and deterministic aborts do not reproduce every disk, OS or power-loss failure. A 230 ms post-action refresh is not a promise that an immediate refresh or crash can complete the 150 ms queued write.

Schema 1 has no legacy persisted format to migrate; unsupported versions are detected and kept. Horizontal chart view/following is persisted through supported APIs; crosshair, vertical price zoom, pane heights, expanded details, page scroll and unsubmitted input drafts are not. Browser-local storage can be unavailable, evicted, cleared, quota-limited or temporary in private mode, and is not a permanent backup or cross-device sync. CSV is a separate journal export, not a restorable session archive. Existing long-history chart-rendering bottlenecks remain.
