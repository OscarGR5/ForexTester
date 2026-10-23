# Task 17 verification

Verified October 23, 2026, on Linux, Node 24.18.0, with Chromium headless and the real local Node HTTP API. No live Dukascopy access, real user storage, cloud service, account, new production dependency or automated trading was used.

## Result and architecture

Filesystem checkpoints replace IndexedDB as the active source of truth. Browser storage can be cleared or replaced without losing committed backtests. The default directory is `$XDG_DATA_HOME/forextester/` for absolute XDG_DATA_HOME, otherwise `~/.local/share/forextester/`; FOREXTESTER_DATA_DIR overrides it outside the repository. The UI shows its absolute configured location.

Storage contains `sessions/<uuid>.json` manifests/tombstones, immutable JSON `checkpoints/<hash>.json`, gzip `equity/<hash>.json.gz` chunks of up to 1,024 observations, shared gzip `history/<fingerprint>.json.gz`, and verified `imports/<legacy-uuid>.json` receipts. A process owner lock and initialization guard prevent multiple backend writers. The API, write protocol, migration rules and manual recovery instructions are specified in [session-persistence.md](session-persistence.md).

Session APIs support list/create/restore/checkpoint/rename/delete, fingerprinted history existence/upload/download, storage status and migration receipt verification. Payload sizes/types, IDs, hashes, traversal, Host and Origin are checked. Vite preserves the browser Host header so strict same-origin validation works through its proxy. The backend remains bound to localhost. Its compiled build was smoke-tested for filesystem status and the unchanged history endpoint/cache directory.

Autosave preserves the 150 ms manual-action/metadata queue, approximately five-second playback cadence, Save now and hidden-page flush attempt. History is durably published first, changed equity chunks and checkpoint next, and the atomic manifest last. Files and directories are synced before confirmation. Only backend confirmation can display Saved. Failed saves retain the previous committed snapshot and unsaved memory; revision conflicts require resuming the authoritative disk version.

Legacy imports validate the existing IndexedDB checkpoint, equity and fingerprint, verify the stored result, then write a separate receipt. Originals are retained. Interruption before/after commit can be retried without duplicate sessions or commissions. Different existing disk work is never overwritten; an explicit separate import preserves both.

localStorage stores per-session layouts/timeframes/indicators, horizontal viewport/following, public price-scale range/autoscale, journal scopes/details/sections, cash-reference visibility, scroll and unsubmitted order/SL drafts. Preferences are validated, bounded and financially inert. Clearing them resets only presentation. New sessions can inherit a layout, then retain independent settings.

## Automated checks

Run from the repository root:

```sh
npm run typecheck
npm run build
npm test
git diff --check
```

The final suite contains **393 tests across 29 files**. Existing execution, commissions, risk, journal/CSV, indicators, chart/replay lookahead and equity tests remain included. New/extended coverage includes:

- XDG/fallback/override directory creation, repository-path rejection, private file creation, two independent sessions, shared history and backend restart.
- Create/read/rename/delete, revisioned tombstones, competing browser clients, a second backend and simultaneous stale-lock recovery.
- Publication order, unchanged full-chunk mtimes, metadata-only saves without equity/history writes, and deterministic interruption at equity, checkpoint and manifest publication.
- Injected ENOSPC, EACCES and EROFS failures preserving a recoverable preceding checkpoint.
- Invalid IDs/traversal, malformed/nonfinite/prototype JSON, wrong content type, oversized bodies, foreign Host/Origin and missing mutation Origin.
- Checkpoint, equity and history SHA-256 tampering; exact historical range/cursor checks; restoration of 129,600 candles and 127 equity chunks.
- IndexedDB import equivalence, retained sources, interrupted/retried imports, a lost commit response, explicit conflict/copy handling and disk recovery after deleting the browser source.
- Invalid/unavailable localStorage, per-session isolation, unsent order restoration without execution, horizontal viewport/following, indicators, public vertical price range and cash-reference restoration.
- StrictMode disk hydration at 1×/10×/100×, pending orders/closes, no duplicate executions/fees/observations, exact equity/drawdown, closed startup on connection failure and Saved remaining unconfirmed until manifest publication.
- Bounded history serialization with independent bid/ask membership preserved.

Every filesystem fixture uses mkdtemp under the OS temporary directory. No test writes into the user's default backtesting directory. Fault injection is at filesystem durability boundaries, not a real disk-fill exercise.

## Chromium and actual backend

The repeatable harness is `scripts/durable-storage-browser.mts`, using `scripts/durable-storage-browser-server.mts` for an offline provider behind the production API. It starts its own backend on 127.0.0.1:3017 and Vite on 127.0.0.1:5187 and uses a fresh temporary data directory. Chromium is supplied by the verification environment, not added to production dependencies. To rerun, provide playwright-core and Chromium in the local test environment; CHROMIUM_PATH can override the harness executable path.

```sh
npx tsx scripts/durable-storage-browser.mts
```

The harness passed:

| Scenario | Verified behavior |
| --- | --- |
| A | Two manual positions, independent SL modifications, notes, replay advancement, commissions, cash/equity/drawdown; page close plus SIGKILL/backend restart; identical financial state restored paused |
| B | IndexedDB and localStorage cleared, page reloaded, same disk session restored with identical financial records/calculations and default UI |
| C | Layout, selected M15, journal scope, expanded statistics and an unsent 0.33-lot draft restored; a three-chart imported session remained isolated from the original one-chart session |
| D | Genuine version-1 IndexedDB source imported; checkpoint and equity identical, source retained; subsequent replay step retained the original entry fee |
| Independent profile | Separate Chromium browser context listed/restored the same filesystem session with default UI preferences |
| Backend unavailable | Visible error with the workspace retained, followed by successful Save now after backend restart |
| Layout | 1440px desktop and 390px mobile screenshots inspected; mobile document width and viewport were both 390px |

No Chromium page exceptions were recorded. Expected Vite proxy connection errors occurred while the test deliberately killed the backend. Screenshots and raw JSON results were produced under `/tmp/task17-desktop.png`, `/tmp/task17-mobile.png` and `/tmp/task17-browser-results.json`, outside the repository.

## Performance and disk usage

`npx tsx scripts/durable-storage-benchmark.mts` uses real localhost HTTP, SHA-256 validation, gzip, fsync and temporary filesystem writes. Its deterministic 90-day dataset contains 129,600 bid and ask candles, 100 manual closed positions and 129,600 equity observations. Numbers are single local samples, not latency guarantees; other verification work shared the machine. Repetitive synthetic data compresses much more than arbitrary real market data.

| Measurement | Sample |
| --- | ---: |
| Initial shared history upload/validation/gzip/sync | 2,104 ms |
| Initial checkpoint with 127,600 observations | 3,244 ms |
| Incremental checkpoint, 2,000 new observations | 70.6 ms |
| Engine processing for those 2,000 observations | 3.94 ms |
| Full checkpoint/equity/history restore over HTTP | 1,590 ms |
| Cold 90-day gzip history read/validation | 268 ms |
| Complete 90-day IndexedDB-to-filesystem migration and verification | 4,320 ms |
| One session at 129,600 observations, including retained prior checkpoint/partial chunks | 1,412,534 bytes |
| Two sessions sharing identical history/equity | 1,510,276 bytes |
| Shared gzip history file | 778,707 bytes |
| Final small checkpoint JSON, including 100 closed positions | 97,502 bytes |

Earlier samples observed 55–90 ms incremental checkpoints and 1.3–2.2 seconds full restores under varying contention. Changed-chunk tests confirm that a metadata-only save writes no history/equity blobs and that extending a partial tail preserves the prior full chunk file and hash.

A separate Chromium sample loaded the same 90-day history, resumed at 101 observations, selected three charts and 100× playback, advanced **2,600 observations**, and ended paused at **2,701 equity points**. Browser restore took **1,035 ms**. During playback, the approximately five-second checkpoint began at **5,143 ms**, transmitted **305,078 bytes** and completed in **63.7 ms**. The pause checkpoint took **25.0 ms**, and a metadata-only Save now request transmitted **2,817 bytes** and completed in **18.9 ms**. History was not retransmitted by these checkpoints. These elapsed HTTP samples include browser/server scheduling; they do not isolate total persistence CPU overhead or establish unchanged throughput for every real-data multi-month chart configuration.

## Recovery and verification limits

Files survive browser storage clearing and independent profiles. Hashes and financial/cursor invariants are checked on restore, and the preceding committed manifest remains valid after pre-commit interruptions. A complete stopped-backend directory copy is a restorable machine-local backup. Files are not synchronized to another computer automatically.

Deletion is logical and revisioned. Immutable checkpoints, unreferenced blobs and stale temporary files are retained; automatic garbage collection is not implemented. Backups therefore include data from deleted sessions. An interrupted initialization can require manual removal of writer-init.lock after all relevant backends are stopped. Unreadable/reused-PID writer locks fail closed. A corrupt committed manifest is surfaced for manual recovery rather than silently selecting a previous snapshot.

Immediate browser termination can lose unsaved memory. A lost HTTP response can leave a commit on disk that the browser did not confirm; reload the saved version after a revision conflict. OS/filesystem/hardware failures can defeat sync guarantees. Injected write failures and SIGKILL tests do not reproduce every power-loss condition.

Browser verification used headless Chromium and viewport emulation. Firefox, Safari, physical mobile hardware, real device power-loss and a physically exhausted disk were not tested. No live Dukascopy requests were made. Crosshairs/custom pane heights and unsupported chart internals are intentionally not restored; viewport/scale limits and scroll restoration are constrained by the public chart API and layout.

## Files changed
- `README.md`
- `backend/package.json`
- `backend/src/app.ts`
- `backend/src/history.ts`
- `backend/src/projectPaths.ts`
- `backend/src/server.ts`
- `backend/src/sessionApi.ts`
- `backend/src/sessionStorage.test.ts`
- `backend/src/sessionStorage.ts`
- `backend/tsconfig.build.json`
- `backend/tsconfig.json`
- `docs/session-persistence.md`
- `docs/task-17-verification.md`
- `frontend/src/App.interaction.test.tsx`
- `frontend/src/App.tsx`
- `frontend/src/EquityChart.tsx`
- `frontend/src/SessionControls.test.tsx`
- `frontend/src/SessionControls.tsx`
- `frontend/src/TradingJournal.tsx`
- `frontend/src/TradingPanel.tsx`
- `frontend/src/analytics.ts`
- `frontend/src/autosave.test.tsx`
- `frontend/src/chartSync.test.ts`
- `frontend/src/chartSync.ts`
- `frontend/src/diskSessionStore.ts`
- `frontend/src/equity.ts`
- `frontend/src/filesystemRecovery.test.tsx`
- `frontend/src/historyLoader.ts`
- `frontend/src/historyRequestBody.test.ts`
- `frontend/src/historyRequestBody.ts`
- `frontend/src/indicatorSettings.ts`
- `frontend/src/indicators.ts`
- `frontend/src/migration.test.ts`
- `frontend/src/sessionCodec.ts`
- `frontend/src/sessionFixtures.ts`
- `frontend/src/sessionStore.ts`
- `frontend/src/sessionTypes.ts`
- `frontend/src/trading.ts`
- `frontend/src/uiPreferences.test.tsx`
- `frontend/src/uiPreferences.ts`
- `frontend/src/useSessionPersistence.ts`
- `frontend/vite.config.ts`
- `scripts/durable-storage-benchmark.mts`
- `scripts/durable-storage-browser-server.mts`
- `scripts/durable-storage-browser.mts`
- `tests/diskApiFixture.ts`
