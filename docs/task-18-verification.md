# Task 18 verification

Verified October 23, 2026 on `fix/storage-reliability-cleanup`, based on updated `main` at `e965799`. All filesystem fixtures used newly created temporary directories. No real saved sessions were read, altered or deleted. No live Dukascopy requests were required.

## Files changed

| Area | Files |
| --- | --- |
| Backend behavior | `backend/src/sessionStorage.ts`, `backend/src/sessionApi.ts`, `backend/src/history.ts`, `backend/src/projectPaths.ts` |
| Backend/filesystem tests | `backend/src/storageMaintenance.test.ts`, `backend/src/projectPaths.test.ts`, `backend/src/sessionStorage.test.ts`, `backend/src/app.test.ts` |
| Frontend behavior and protocol | `frontend/src/storageProtocol.ts`, `frontend/src/diskSessionStore.ts`, `frontend/src/useSessionPersistence.ts`, `frontend/src/SessionControls.tsx`, `frontend/src/App.tsx` |
| Frontend tests | `frontend/src/historyRepair.test.tsx`, `frontend/src/filesystemRecovery.test.tsx`, `frontend/src/SessionControls.test.tsx`, `frontend/src/App.interaction.test.tsx` |
| Browser fixtures | `scripts/storage-maintenance-browser.mts`, `scripts/durable-storage-browser-server.mts` |
| Documentation | `README.md`, `docs/session-persistence.md`, `docs/task-18-verification.md` |

## Implementation

Normal resume downloads nothing. Missing/corrupt history offers an explicit repair action with chunk progress. It downloads the saved trading range and 30-day pre-roll through the existing seven-day loader, validates every observation and compares the canonical SHA-256 fingerprint. The backend independently verifies that same identity before atomically publishing an identical replacement. A valid object is never rewritten. Ordinary restore installs the original checkpoint and ledger paused without executing historical trades or charging commissions. Repair also works when history failure blocks flushing an already open session.

Stable JSON error codes distinguish missing history (404), corrupt history (422), invalid replacement observations (400), fingerprint mismatch (409), storage/backend outages, permissions, disk capacity and unsafe paths. HEAD exposes its code in `X-Storage-Error-Code`. A fingerprint mismatch does not activate session revision-conflict handling. Changed provider prices are rejected with retry and original-backup instructions.

Cleanup is explicit, previewable and confirmed. Each invocation validates all active manifests, checkpoints, referenced equity and history before marking shared live objects. A failed mark or unsafe file type refuses deletion. Sweep considers only managed content names and temporary-write names at least seven days old, based on modification time. Active objects, shared history, recent objects, manifests, tombstones, receipts, locks, unknown regular files and legacy browser sessions are retained. The serialized deletion operation recomputes references independently of preview, rechecks file identity/type and reports partial failures for retry.

The Dukascopy cache and WAF token now use `$XDG_CACHE_HOME/forextester/dukascopy/`, falling back to `~/.cache/forextester/dukascopy/`. `FOREXTESTER_CACHE_DIR` replaces the application cache root, with `dukascopy/` beneath it. Repository paths, repository symlink targets and overlap with durable storage are rejected. Existing request shapes, bid/ask values, retry settings, optional Chrome path and provider caching options are preserved. The old repository cache is untouched; manual copying while stopped is documented.

## Automated checks performed

```sh
npm run typecheck
npm run build
npm test
git diff --check
```

All passed. Vitest reported **433 passing tests across 32 files**. The build retains Vite's nonfatal warning about a JavaScript chunk exceeding 500 kB; bundle splitting is outside this task.

The new and extended deterministic tests cover:

- Missing files, invalid gzip/JSON, malformed observations and stored fingerprint mismatch.
- Exact repair, changed-price rejection in browser and backend, preserved valid originals, interrupted publication and retry.
- Shared-history repair with original checkpoints, execution cursor, journal, commissions and equity unchanged.
- Backend/network failure, unavailable history directories and unclassified HEAD failures without mistaken corruption or replacement.
- Seven-day loading with pre-roll, observation validation and chunk progress.
- Repaired StrictMode hydration at 1×, 10× and 100×, paused, followed by deterministic continuation without duplicate fees or equity.
- Read-only preview, exact seven-day boundary, recent-file protection, active checkpoint/equity retention and shared-history retention.
- Unreadable manifests/checkpoints/equity/history, stale previews and independent reference recomputation.
- Partial cleanup failure and retry; changed candidates, symlinks, unexpected types and traversal refusal.
- Tombstones, migration receipts and locks retained; multiple active sessions restored after cleanup; later incremental save succeeds.
- UI confirmation and cancellation, mismatch recovery messaging, explicit repair and absence of automatic repair downloads.
- XDG, fallback and override cache paths, safe directory creation, repository and symlink rejection, storage/cache separation and preserved provider settings.

The UI detector returned no findings for the changed session controls.

## Chromium checks performed

Command:

```sh
node_modules/.bin/tsx scripts/storage-maintenance-browser.mts
```

This launches the actual local Node backend, Vite and Chromium. A deterministic offline provider sits behind the real `/api/history` endpoint. Browser storage, durable storage, cache and provider-mode controls use an isolated temporary directory removed afterward.

| Scenario | Observed result |
| --- | --- |
| Manual entries | Two manually requested buys execute on the next candle with the configured commissions |
| Automatic stop | An adjusted stop closes the first position with `stop_loss` |
| Manual close | The second position closes with `manual` |
| Save now and autosave | Both commit the visible execution cursor to the filesystem; the harness waits for the matching cursor |
| Journal CSV | Download succeeds and contains both stop-loss and manual-close records |
| Missing-history repair | Removing the history file blocks resume and exposes repair; matching download restores paused with identical checkpoint and equity chunk hashes |
| Changed prices | A corrupt object plus shifted provider prices rejects replacement; original corrupt bytes, trading data, equity and cursor remain intact |
| Corrupt-history retry | Returning the provider to identical prices allows explicit repair and paused restore |
| Shared history and cleanup | A second session shares the history; deletion tombstones the first; preview preserves files; confirmed cleanup removes only eligible unreferenced objects |
| Reclaimed fixture data | **18 files, 54,419 bytes**, including a controlled 1,234-byte obsolete checkpoint; totals can vary with autosave timing |
| Recovery after cleanup | Surviving session restores after refresh with identical checkpoint; subsequent Save now succeeds |
| Deleted session | GET returns 404 after cleanup |
| Desktop | 1440 px viewport, 1440 px document width |
| Mobile | 390 px viewport, 390 px document width |
| Browser exceptions | None |

Local artifacts from the completed run: `/tmp/task18-browser-results.json`, `/tmp/task18-repair.png`, `/tmp/task18-mismatch.png`, `/tmp/task18-1440.png`, `/tmp/task18-390.png`. The mobile screenshot was visually inspected. These artifacts are not committed.

## Limits

Live provider availability, WAF challenge acquisition and historical-price reproducibility were not tested against Dukascopy. If the provider cannot reproduce the original fingerprint, a separately backed-up original dataset is required. There is no general dataset upload UI.

Cleanup deliberately refuses to run while any active saved session cannot be fully validated, including history needing repair. A large store requires reading its active data and occupies the serialized storage queue during maintenance. Concurrent manual filesystem edits are unsupported; stop the backend before copying or restoring files. Fault injection verifies interruption boundaries and retry behavior, not power-loss durability on every filesystem/device.

No new dependencies, persistence technology, trading rules, risk/commission formulas or chart features were introduced. No outstanding product decisions remain. Merge requires the project lead's approval.
