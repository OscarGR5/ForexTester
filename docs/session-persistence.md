# Session persistence, record schema 2 and filesystem format 1

`frontend/src/sessionTypes.ts` defines schema-2 `SessionRecord` with explicit lifecycle and accepts validated schema-1 records. It preserves the full trading/replay checkpoint, flat equity summary and ordered equity SHA-256 hashes. Existing financial transitions and formulas are unchanged. The backend and browser share the existing validators. Financial models use Node-compatible `.js` import specifiers; the backend build emits their transitive modules under `backend/dist/frontend/src/` and starts `backend/dist/backend/src/server.js`. Indicator settings validation is a pure module and does not load chart/indicator calculation code in the backend. Dukascopy's temporary cache is outside the repository in both source and compiled execution; it is independent of authoritative saved histories.

## Lifecycle migration

Schema 2 checkpoints require `lifecycle`: `setup`, `trading`, or `finished`. Existing schema-1 records are validated against their original digest before deriving unstarted → setup, started → trading, complete → finished. The next checkpoint writes schema 2 atomically; original financial records, equity chunks, exclusive date ranges and history fingerprints are unchanged. The IndexedDB database version remains 1. Active recovery is paused, finished recovery opens Results, and unsubmitted stop-placement drafts are never persisted or restored. Setup becomes durable after its first successful historical load.

## Storage authority and location

The Node filesystem store is authoritative for records and revisions. IndexedDB is solely the legacy migration source and may cache matching history during legacy recovery. localStorage contains optional presentation state. Active backtests never write a second browser checkpoint.

Storage directory selection, in order:

1. `FOREXTESTER_DATA_DIR`, resolved by the backend, never accepted from the browser.
2. Absolute `$XDG_DATA_HOME/forextester/`.
3. `~/.local/share/forextester/`.

The backend creates private directories (0700) and files (0600), subject to existing directory permissions and the OS. Repository-contained storage, including symlink targets, is rejected. Existing symlinked storage subdirectories are rejected. The UI displays the resolved configured path. All automated filesystem and browser checks use newly created temporary directories and remove them afterward.

```text
forextester/
  writer.lock                         # one backend PID; exclusive creation
  writer-init.lock                    # brief guard during lock recovery/initialization
  sessions/<uuid>.json                # authoritative manifest or deletion tombstone
  checkpoints/<sha256>.json           # immutable schema-1 or schema-2 SessionRecord
  equity/<sha256>.json.gz             # immutable arrays of <=1,024 EquityPoints
  history/<fingerprint>.json.gz        # shared validated bid/ask LoadedHistory
  imports/<legacy-uuid>.json           # verified source digest/revision and disk target ID
```

Only canonical UUIDs and 64-character lowercase SHA-256 strings are used in file names. Temporary files append an independent UUID and `.tmp` beside the destination. There are no arbitrary filesystem API endpoints. A session manifest contains `{version:1, revision, hash}`; `hash:null` is a deletion tombstone. IDs are never reused after deletion.

`SessionRecord` retains name, UUID, creation/save UTC ISO timestamps, EURUSD, selected range, historical fingerprint, revision, progress/status, checkpoint, chunk hashes and digest. The checkpoint contains replay start/index/speed, execution cursor, complete TradingState (pending entries/closes, open/closed/rejected/cancelled orders, SL chains/coverage, setups/notes/tags, account/commission configuration and deterministic counters), and equity cash, high-water mark and drawdown summary. `workspace` remains as a valid default placeholder for schema compatibility; current presentation settings are independently stored in localStorage. Legacy imports retain their original workspace settings and seed the imported session's browser preferences.

Engine/candle/equity times are UTC Unix milliseconds. Viewport bounds are UTC Unix seconds. Dates are YYYY-MM-DD, start inclusive/end exclusive. No synthetic quote or valuation is introduced.

## Write and concurrency protocol

`AutosaveQueue` coalesces writes and always captures the newest available workspace state when a write begins. Manual financial actions, metadata/notes, single steps and pauses use the existing 150 ms queue. Playing sessions request a checkpoint roughly every five seconds. Save now, switching sessions and visibility changes flush this queue. No asynchronous shutdown flush is guaranteed.

1. Validate history and compute its existing fingerprint once per loaded dataset. HEAD checks avoid retransmitting a stored dataset. A missing dataset is uploaded once and validated by the backend. Large browser history uploads serialize in bounded 2,048-candle batches with event-loop yields. History must be committed before the session checkpoint can reference it.
2. Walk the linked equity ledger backward only through the unsaved suffix and at most one partial 1,024-point chunk. Keep hashes of prior full chunks. No JSON serialization of the linked chain occurs.
3. Build and validate the record and changed chunk hashes in the browser. The backend serializes operations under a single directory owner and compares the expected revision with the current manifest. A missing/deleted/stale checkpoint cannot bypass compare-and-swap.
4. Validate the record digest, trading/account invariants, exact dataset/cursor/quote, chunk sizes/hashes and incremental equity prefix. Validate only appended observations against the previous cached validated ledger during ordinary saves; rebuild from validated chunks after a backend restart. Account-balance resets and replay restarts replace the ledger epoch.
5. Write missing/changed immutable gzip equity blobs, then an immutable JSON checkpoint. Every file is written to a unique temporary file, synced, atomically renamed, and its containing directory synced. Validate before publishing. Existing full equity chunks and complete market history are not rewritten on autosaves.
6. Write, sync and rename the small manifest **last**, then sync the sessions directory. Only after confirmation does the browser advance its committed revision, successful-save time and Saved status. A newer queued snapshot keeps Saving visible until its own confirmation.

The process-level writer lock uses exclusive file creation and a PID liveness check. A separate exclusive initialization guard prevents simultaneous starters from racing while replacing a dead process lock. A second backend cannot edit the same directory. Within that backend every mutation, including rename, deletion and import confirmation, is serialized. Revision checks are authoritative across independent browsers/profiles; BroadcastChannel only shortens conflict detection for tabs sharing that browser storage partition.

An interrupted pre-manifest write leaves the previous manifest and every object it references untouched. Incomplete `.tmp` files are never read. A lost response after a successful commit is ambiguous to the client; a subsequent stale retry receives a conflict and must reload the saved version. New immutable objects and previous checkpoints are retained until explicit cleanup. Deletion publishes a revisioned tombstone. No background garbage collection runs; the opt-in mark-and-sweep below reclaims only sufficiently old unreferenced managed objects. There is no automatic rollback from a corrupt committed manifest; keep the directory for manual recovery or a compatible app.

## History and equity integrity

History fingerprints retain the original canonical encoding: UTF-8 `EURUSD/M1/v1/from/tradingFrom/to/`, independent side lengths, then timestamp/open/high/low/close as explicit little-endian float64 values. Bid, ask, gaps, pre-roll and range boundaries all participate. Equal fingerprints share one history file across sessions. Gzip is transport-independent; validation hashes the canonical candle data, not gzip bytes.

Checkpoints hash their complete stored JSON in the manifest and retain the existing digest excluding the `digest` field. Equity blobs hash their uncompressed JSON arrays. Restoration verifies file hashes, record schema/digest and engine invariants before installing state. Chunks are checked for ordering/size; the ledger is rebuilt iteratively, checking timestamps, missing marks, cash, high-water marks and drawdown. Every equity observation must match the exact replay-prefix candle. The backend keeps at most two validated history datasets and two ledger tails in memory; a new backend verifies stored data before reuse.

An active replay requires `executionCursor = replay.index + 1`, `equity.count = executionCursor - replay.startIndex`, and matching final timestamps. An unstarted replay has no execution or equity observations. Recovery installs the saved engine, ledger and processed cursor together and pauses playback. The next step processes N+1, with no synthesized entry, exit or fee. Charts still consume only the revealed prefix.

Disk recovery never silently downloads substitute history. Missing/corrupted history stops resume and presents **Repair historical data** for that session. No automatic download occurs during resume. On explicit repair, the existing `HistoryLoader` downloads the exact saved range plus 30 calendar days of pre-roll with its seven-day requests and two concurrent workers. Every returned bid/ask observation, range, gap and timestamp is validated before canonical SHA-256 comparison in the browser and independently on the backend. Progress shows completed/total chunks. A failed chunk reports its range and leaves trading data intact.

Only a fingerprint identical to the saved `historyId` can be published. The existing PUT history endpoint accepts fully verified identical data for a missing/corrupt object and uses a synced temporary file followed by atomic rename and directory sync. A valid existing history object is left untouched. A publication failure before rename preserves the existing bytes. Shared sessions keep the same history ID and all benefit from repair. A successful operation retries ordinary restoration and installs the saved checkpoint, equity ledger and execution cursor paused. No historical trading event runs and no commission is charged again.

A mismatch is rejected with an explanation that the provider returned different prices. The session, checkpoints, journal, positions, equity and any available history file remain intact. Retry later or restore the exact original `history/<historyId>.json.gz` from a separately backed-up original dataset while the backend is stopped. Back up the current directory first. Never edit the saved fingerprint to accept changed prices: those prices could change stop triggers, fills and past outcomes. There is no arbitrary file-upload UI.

GET/HEAD history distinguish `HISTORY_MISSING` (404) from `HISTORY_CORRUPT` (422). PUT rejects invalid replacement observations as `HISTORY_INVALID` (400) and a different fingerprint as `HISTORY_FINGERPRINT_MISMATCH` (409). Filesystem read errors and backend/network outages remain storage failures, never historical corruption. Error JSON contains `{code,error}`; HEAD carries `X-Storage-Error-Code` because it has no body. Other stable storage classifications include `STORAGE_UNAVAILABLE`, `STORAGE_FULL`, `STORAGE_PERMISSION_DENIED`, `STORAGE_DATA_MISSING`, `STORAGE_UNSAFE_PATH`, `STORAGE_REQUEST_INVALID`, `SESSION_NOT_FOUND` and `SESSION_CONFLICT`. Only session revision conflicts activate stale-editor handling.

Legacy imports may use the original downloader when their browser cache is missing, but still require the exact original fingerprint before import.

## Explicit storage cleanup

Use **Storage maintenance → Preview cleanup → Clean up unused files**, then confirm. The dry run reports `safe`, `candidateFiles`, `reclaimableBytes`, and counts/bytes for `checkpoints`, `equity`, `history` and `temporary`. A safe preview with zero files has nothing to delete. Preview does not delete or rewrite data objects. Storage initialization can still create its normal directories and writer lock.

The mark phase reads every committed UUID session manifest. Tombstones remain but do not retain their deleted session's old blobs. Each active checkpoint must pass its manifest hash, record digest and schema validation. Cleanup also verifies all referenced equity chunks, rebuilds their ledger, validates history and checks exact checkpoint/cursor/observation alignment, bypassing the in-memory history/ledger caches. Any unreadable active manifest, checkpoint, equity/history object or unsafe managed file/directory type makes `safe:false` with `CLEANUP_UNSAFE`; no files are deleted. This deliberately blocks cleanup while an active history needs repair.

The sweep considers only narrowly named content objects in `checkpoints/`, `equity/`, `history/`, plus UUID-suffixed `.tmp` files beside known destinations in those directories, `sessions/` and `imports/`. Objects referenced by any active session remain. Unreferenced objects and temporary files need a modification time at least **seven days** in the past. Recent objects are protected because they may belong to an interrupted save. Unknown regular file names are retained. Symlinks, directories masquerading as blobs and other unexpected file types refuse cleanup. No API accepts arbitrary cleanup paths.

Committed session manifests, tombstones, migration receipts and backend locks are never sweep candidates. Legacy IndexedDB records remain untouched. The seven-day rule does not retain deleted-session recovery blobs forever; copy the durable directory while the backend is stopped before major maintenance.

POST cleanup requires `{confirm:true}` and independently recomputes the complete mark-and-sweep plan inside the existing serialized storage queue immediately before deletion. It does not trust preview paths or totals. Each candidate's type, parent directory and device/inode/size/modification/change timestamps are checked again before unlink. Changed candidates are retained for another attempt. Directories are synced after deletion. Partial results report `removedFiles`, `reclaimedBytes`, `remainingFiles` and per-file failures; preview and retry are supported. A directory-sync failure is reported even if its unlink succeeded. Counts describe successful unlinks, while failures identify operations whose durability was not confirmed. These protections assume the backend owns storage and operators do not concurrently modify its files.

## Temporary Dukascopy cache

The application cache root is `FOREXTESTER_CACHE_DIR` if provided, otherwise absolute `$XDG_CACHE_HOME/forextester`, otherwise `~/.cache/forextester`. Provider data and the WAF token live under `dukascopy/` in that root. Thus the default provider path is `$XDG_CACHE_HOME/forextester/dukascopy/` or `~/.cache/forextester/dukascopy/`. Relative XDG values are ignored. `FOREXTESTER_CACHE_DIR` overrides the application cache root, not durable session storage.

Directories are created with private permissions. Existing ancestors are resolved before directory creation; repository paths and symlink targets inside the repository are rejected. The provider subdirectory cannot be a symlink, and cache paths cannot overlap the configured durable data directory. Daily response caching, `useCache:true`, retry count, bid/ask shapes, dates and optional `DUKASCOPY_CHROME_PATH` stay unchanged. There is no cache-to-history fingerprint migration.

The repository's old `.cache/dukascopy` is left untouched. Cold downloads are acceptable. To reuse it, stop the backend, create the chosen application cache root, then copy the whole old `dukascopy` directory into that root with `cp -a` when the destination does not already exist. Verify the copy before removing the old cache manually. See README for a command example. Never treat temporary provider cache files as a durable saved-session backup.

## Local API

All paths below are relative to `/api/storage`. The production server remains bound to 127.0.0.1. Reads return JSON except HEAD. Content-Type must be application/json for bodies.

| Method/path | Behavior |
| --- | --- |
| GET `/status` | Storage directory, filesystem authority, schema version; initialization errors are returned visibly |
| GET `/sessions` | Readable records plus isolated `{id,revision,error}` entries for unreadable sessions |
| POST `/sessions/:uuid` | Create checkpoint with expectedRevision 0 |
| GET `/sessions/:uuid` | Read one consistent record plus its verified equity chunks |
| PUT `/sessions/:uuid/checkpoint` | Save `{record,chunks,expectedRevision}`; chunks contain only changed hash/points pairs |
| PATCH `/sessions/:uuid` | Rename with `{name,revision}` |
| DELETE `/sessions/:uuid` | Revisioned deletion with `{revision}` |
| HEAD `/history/:fingerprint` | Validate shared history; missing/corrupt/storage error code in header |
| PUT `/history/:fingerprint` | Validate exact fingerprint; store or atomically repair shared LoadedHistory |
| GET `/history/:fingerprint` | Retrieve verified LoadedHistory |
| GET `/cleanup` | Read-only cleanup preview, including safety and candidate totals |
| POST `/cleanup` | Explicit `{confirm:true}`; revalidate live references and remove eligible files |
| GET `/sessions/:legacyUuid/migration` | Get verified migration receipt or null |
| POST `/sessions/:legacyUuid/migration` | Confirm `{targetId,revision,sourceRevision,digest}` only after matching the source and validating the saved result |

The existing GET `/api/history` EURUSD endpoint and seven-day limit are preserved. Checkpoint bodies are bounded to 40 MiB, history to 64 MiB, and rename/delete/receipt bodies to 4 KiB. JSON must be an object, with finite numbers and no prototype-manipulation keys. Invalid IDs, encoded paths, traversal and unrestricted paths are rejected. Mutations require Origin exactly matching the localhost Host header. Cross-origin Origins and cross-site fetch metadata are rejected; CORS is not enabled. Vite's proxy explicitly preserves Host (`changeOrigin:false`) so normal same-origin browser writes pass that check. Journals and complete session bodies are never logged by storage handlers.

## Nondestructive IndexedDB migration

The legacy database remains `forextester-sessions`, version 1, stores `sessions`, `equity` and `history`. It is never dropped or upgraded by this task. Startup lists browser sources separately from disk records and compares each source digest with its filesystem import receipt.

Import validates the legacy checkpoint, ordered equity chunks, cash/drawdown and exact historical fingerprint with the existing adapter. It creates the disk session at revision 1 while preserving source creation/save timestamps and data. A successful import reads back the stored checkpoint/chunks/history, verifies them, and only then writes a separate receipt. The backend independently reconstructs the source digest (original ID/revision) and verifies the stored state before confirming that receipt. No browser copy is deleted or marked complete prematurely.

If interrupted before commit, retry creates the session. If interrupted after commit but before receipt, retry accepts only a checkpoint reproducing the original digest, then verifies it and confirms the receipt. It never overwrites a different disk version. A conflicting source offers an explicit separate import with a new UUID; both versions remain. Receipt and source-digest comparison also detects browser copies edited after migration. After migration, active trading uses only the disk version.

## Presentation preferences

`forextester:ui:v1:<stable-session-uuid>` is a versioned localStorage JSON envelope. Fields include workspace chart count/timeframes/indicator overrides, per-pane UTC horizontal viewports, logical spans and following preferences; per-pane/timeframe public price-scale autoScale and visible range; journal view/statistics scope; expanded setup/position and section selection; page scroll and the equity cash-reference toggle. There are no candle, execution, closed-position or equity arrays in localStorage.

Preference readers enforce types, allowed timeframes/scopes, indicator bounds, valid finite ranges, bounded strings and a 100,000-character envelope cap. Malformed/unavailable storage falls back to defaults. Preference updates never call trading transitions. Per-session keys prevent one workspace from changing another. New workspaces may inherit the existing layout as their initial value, then diverge independently.

Horizontal viewport and vertical range interaction writes use a 250 ms batching timer, with visibility/page-hide attempts. Horizontal changes also flush a durable checkpoint. Each checkpoint captures the current workspace preferences and per-chart viewport state. Recovery seeds missing browser workspace preferences from that checkpoint. Older shared viewports remain valid and seed each chart independently; existing fingerprints and financial state are unchanged. Supported Lightweight Charts logical-range and price-scale getVisibleRange/setVisibleRange/autoScale APIs handle restoration. Library zoom limits and available revealed bars can constrain horizontal results. Vertical ranges apply to the price series, not internal indicator scales. Exact crosshair positions, custom pane heights and chart internals are not restored. Scroll restoration is best effort after layout creation. Preferences can be lost without financial consequences.

## Failure recovery and backups

A disconnected backend never initializes an unrelated active session. Startup waits for retry; an existing workspace retains unsaved memory while the page stays open. Disk-full, quota, read-only and permission failures leave the preceding committed checkpoint recoverable and report Error. Restore and writes fail visibly on integrity errors. Valid sessions remain listed when a different session is unreadable. Explicit deletion is available when its manifest revision remains readable.

Before major maintenance, stop the backend and copy the **entire** durable data directory for a restorable machine-local backup. Restore while stopped, or point FOREXTESTER_DATA_DIR at that complete copy. Copying selected manifests without their referenced objects is insufficient. Copying an actively changing directory is not a consistent backup. Files do not synchronize across machines. CSV exports journals only.

A stale PID lock is removed only after its recorded process is absent. An unreadable/partial lock, permission-denied liveness check or reused live PID fails closed; after stopping every relevant backend, the operator can remove writer.lock and retry. A crash during initialization can leave writer-init.lock; remove it only after every backend using the directory is stopped. Unpublished temporary files are ignored during recovery and may be removed only by confirmed cleanup after seven days. Do not remove content blobs or edit hashes to bypass integrity checks. fsync/rename durability depends on Linux, the filesystem and hardware honoring those operations; deterministic fault tests and SIGKILL recovery cannot prove power-loss behavior on every storage device.
