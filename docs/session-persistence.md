# Session persistence, schema 1 and filesystem format 1

`frontend/src/sessionTypes.ts` preserves the version-1 `SessionRecord`, full trading/replay checkpoint, flat equity summary and ordered equity SHA-256 hashes. Existing financial transitions and formulas are unchanged. The backend and browser share the existing validators. Financial models use Node-compatible `.js` import specifiers; the backend build emits their transitive modules under `backend/dist/frontend/src/` and starts `backend/dist/backend/src/server.js`. Indicator settings validation is a pure module and does not load chart/indicator calculation code in the backend. Dukascopy's separate repository `.cache/dukascopy/` location remains unchanged in source and compiled execution.

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
  checkpoints/<sha256>.json           # immutable schema-1 SessionRecord
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

An interrupted pre-manifest write leaves the previous manifest and every object it references untouched. Incomplete `.tmp` files are never read. A lost response after a successful commit is ambiguous to the client; a subsequent stale retry receives a conflict and must reload the saved version. New immutable objects and previous checkpoints are retained. Deletion publishes a revisioned tombstone; automatic blob garbage collection is deliberately absent, so disk use grows with checkpoints, failed writes and deletions. This avoids deleting objects shared with valid sessions. There is no automatic rollback from a corrupt committed manifest; keep the directory for manual recovery or a compatible app.

## History and equity integrity

History fingerprints retain the original canonical encoding: UTF-8 `EURUSD/M1/v1/from/tradingFrom/to/`, independent side lengths, then timestamp/open/high/low/close as explicit little-endian float64 values. Bid, ask, gaps, pre-roll and range boundaries all participate. Equal fingerprints share one history file across sessions. Gzip is transport-independent; validation hashes the canonical candle data, not gzip bytes.

Checkpoints hash their complete stored JSON in the manifest and retain the existing digest excluding the `digest` field. Equity blobs hash their uncompressed JSON arrays. Restoration verifies file hashes, record schema/digest and engine invariants before installing state. Chunks are checked for ordering/size; the ledger is rebuilt iteratively, checking timestamps, missing marks, cash, high-water marks and drawdown. Every equity observation must match the exact replay-prefix candle. The backend keeps at most two validated history datasets and two ledger tails in memory; a new backend verifies stored data before reuse.

An active replay requires `executionCursor = replay.index + 1`, `equity.count = executionCursor - replay.startIndex`, and matching final timestamps. An unstarted replay has no execution or equity observations. Recovery installs the saved engine, ledger and processed cursor together and pauses playback. The next step processes N+1, with no synthesized entry, exit or fee. Charts still consume only the revealed prefix.

Disk recovery never silently downloads substitute history. Missing/damaged files stop recovery visibly. Legacy imports may use the original downloader when their browser cache is missing, but require the exact original fingerprint before import. History repair requires the original matching dataset or a complete backup.

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
| HEAD `/history/:fingerprint` | Validate existence of shared history |
| PUT `/history/:fingerprint` | Validate and store LoadedHistory once |
| GET `/history/:fingerprint` | Retrieve verified LoadedHistory |
| GET `/sessions/:legacyUuid/migration` | Get verified migration receipt or null |
| POST `/sessions/:legacyUuid/migration` | Confirm `{targetId,revision,sourceRevision,digest}` only after matching the source and validating the saved result |

The existing GET `/api/history` EURUSD endpoint and seven-day limit are preserved. Checkpoint bodies are bounded to 40 MiB, history to 64 MiB, and rename/delete/receipt bodies to 4 KiB. JSON must be an object, with finite numbers and no prototype-manipulation keys. Invalid IDs, encoded paths, traversal and unrestricted paths are rejected. Mutations require Origin exactly matching the localhost Host header. Cross-origin Origins and cross-site fetch metadata are rejected; CORS is not enabled. Vite's proxy explicitly preserves Host (`changeOrigin:false`) so normal same-origin browser writes pass that check. Journals and complete session bodies are never logged by storage handlers.

## Nondestructive IndexedDB migration

The legacy database remains `forextester-sessions`, version 1, stores `sessions`, `equity` and `history`. It is never dropped or upgraded by this task. Startup lists browser sources separately from disk records and compares each source digest with its filesystem import receipt.

Import validates the legacy checkpoint, ordered equity chunks, cash/drawdown and exact historical fingerprint with the existing adapter. It creates the disk session at revision 1 while preserving source creation/save timestamps and data. A successful import reads back the stored checkpoint/chunks/history, verifies them, and only then writes a separate receipt. The backend independently reconstructs the source digest (original ID/revision) and verifies the stored state before confirming that receipt. No browser copy is deleted or marked complete prematurely.

If interrupted before commit, retry creates the session. If interrupted after commit but before receipt, retry accepts only a checkpoint reproducing the original digest, then verifies it and confirms the receipt. It never overwrites a different disk version. A conflicting source offers an explicit separate import with a new UUID; both versions remain. Receipt and source-digest comparison also detects browser copies edited after migration. After migration, active trading uses only the disk version.

## Presentation preferences

`forextester:ui:v1:<stable-session-uuid>` is a versioned localStorage JSON envelope. Fields include workspace chart count/timeframes/indicator overrides, UTC horizontal viewport and following preference; per-pane/timeframe public price-scale autoScale and visible range; order sizing mode, risk/lots/SL/setup draft; unsent replacement SL drafts; journal view/statistics scope; expanded setup/position and section selection; page scroll and the equity cash-reference toggle. There are no candle, execution, closed-position or equity arrays in localStorage.

Preference readers enforce types, allowed timeframes/scopes, indicator bounds, valid finite ranges, bounded strings and a 100,000-character envelope cap. Malformed/unavailable storage falls back to defaults. Preference updates never call trading transitions. Per-session keys prevent one workspace from changing another. New workspaces may inherit the existing layout as their initial value, then diverge independently.

Horizontal viewport and vertical range interaction writes use a 250 ms batching timer, with visibility/page-hide attempts. Supported Lightweight Charts logical-range and price-scale getVisibleRange/setVisibleRange/autoScale APIs handle restoration. Library zoom limits and available revealed bars can constrain horizontal results. Vertical ranges apply to the price series, not internal indicator scales. Exact crosshair positions, custom pane heights and chart internals are not restored. Scroll restoration is best effort after layout creation. Preferences can be lost without financial consequences.

## Failure recovery and backups

A disconnected backend never initializes an unrelated active session. Startup waits for retry; an existing workspace retains unsaved memory while the page stays open. Disk-full, quota, read-only and permission failures leave the preceding committed checkpoint recoverable and report Error. Restore and writes fail visibly on integrity errors. Valid sessions remain listed when a different session is unreadable. Explicit deletion is available when its manifest revision remains readable.

Stop the backend and copy the **entire** data directory for a restorable machine-local backup. Restore while stopped, or point FOREXTESTER_DATA_DIR at that complete copy. Copying selected manifests without their referenced objects is insufficient. Copying an actively changing directory is not a consistent backup. Files do not synchronize across machines. CSV exports journals only.

A stale PID lock is removed only after its recorded process is absent. An unreadable/partial lock, permission-denied liveness check or reused live PID fails closed; after stopping every relevant backend, the operator can remove writer.lock and retry. A crash during initialization can leave writer-init.lock; remove it only after every backend using the directory is stopped. Unpublished temporary files are ignored, not automatically deleted. Do not remove content blobs or edit hashes to bypass integrity checks. fsync/rename durability depends on Linux, the filesystem and hardware honoring those operations; deterministic fault tests and SIGKILL recovery cannot prove power-loss behavior on every storage device.
