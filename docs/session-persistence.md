# Session persistence schema, version 1

The browser database is `forextester-sessions`, IndexedDB version **1**. `SessionRecord.schemaVersion` independently identifies the snapshot format. No production dependencies were added. `fake-indexeddb` is a development-only test adapter; production uses the browser API directly. Existing financial transitions in `trading.ts` and `equity.ts` are unchanged.

| Object store | Primary key | Contents |
| --- | --- | --- |
| `sessions` | `id` (UUID) | Name; creation/save UTC ISO timestamps; schema version; EURUSD; selected dates; history SHA-256; revision; status (`paused`, `complete`, `in-progress`); progress/list metadata; full checkpoint; ordered equity chunk hashes; checkpoint SHA-256 digest |
| `equity` | `[sessionId, index]` | Zero-based ordered chunk, up to **1,024** flat `EquityPoint` objects, and chunk SHA-256 |
| `history` | `id` (history SHA-256) | One validated `LoadedHistory` shared across sessions, including independent bid/ask arrays, date bounds and 30-day pre-roll |

Times in engine, candle and equity data are UTC Unix milliseconds. Synchronized viewport bounds use UTC Unix seconds, matching Lightweight Charts. Date bounds use `YYYY-MM-DD`, start inclusive/end exclusive. Creation/save metadata uses explicit UTC ISO strings ending in `Z`.

`SessionCheckpoint` stores `ReplayCheckpoint`, `executionCursor`, the complete `TradingState`, a flat `EquitySummary` without linked nodes, and `WorkspaceSettings`. The production interfaces are in `frontend/src/sessionTypes.ts`. Engine state includes pending/rejected/cancelled entries, open positions and pending closes, closed executions, original risk and fee configuration, SL and coverage histories, setups/metadata, quote clock and next-ID counters. Setup and position IDs remain deterministic inside the session; the outer UUID gives each saved backtest a separate namespace.

## Atomic checkpoints

`useSessionPersistence` captures the most recent committed React workspace state. An `AutosaveQueue` serializes writes and coalesces requests received during a write into another pass using the latest state. Important changes use a 150 ms prompt queue; active playback uses a 5-second interval. A visibility-change event attempts a flush. Manual Save now and session switches flush the same queue. There is no guaranteed shutdown write.

The store walks backward from the linked ledger tail only as far as the previous saved count rounded down to the current 1,024-point chunk boundary. It reverses that suffix into chronological chunks and hashes only changed chunks. Full historical chunks retain their prior hashes and records. A metadata-only save with no new observations writes no equity chunks. Restart changes the engine epoch and replaces that session’s chunks inside the checkpoint transaction.

Chunk hashes and the checkpoint digest are prepared before opening the read/write transaction. A single transaction covering `sessions` and `equity` reads the current session revision and requires the caller’s expected revision. It then writes all changed chunks and the referencing checkpoint. Abort, interruption or quota failure leaves the previous complete checkpoint and chunks authoritative. The active revision and UI save time change only after `transaction.oncomplete`.

The smaller checkpoint commits before attempting to cache the much larger historical dataset. If the history cache write fails, the checkpoint remains valid and the interface shows its recovery dependency. Save now retries this cache attempt. History is never serialized or written on each M1 tick.

## History identity

Canonical history hashing uses a UTF-8 `EURUSD/M1/v1/from/tradingFrom/to/` prefix followed by each side’s length and each candle’s timestamp/open/high/low/close, encoded as explicit little-endian IEEE-754 float64 values. Both sides, their independent chronological membership, gaps, warm-up and trading bounds participate. Matching dates alone are insufficient.

Cached history passes the existing candle/range validator and a fingerprint comparison. A missing or corrupt cache invokes a fresh instance of the existing chunked loader, so a failed recovery retry cannot reuse a mismatched in-memory download. A redownload must reproduce the stored fingerprint before the cache is replaced or execution is restored. Deleting the last session referencing a dataset also removes its history cache in the same transaction as deletion; other sessions retain shared history.

## Deliberate recovery

1. Read the selected record, all its chunks and its cached history in one read-only transaction. Concurrent saves cannot mix record and chunk generations.
2. Reject unsupported versions. Verify the checkpoint digest and essential structure, unique IDs/counters, setup direction/slot limits, account/risk/commission configuration, fill accounting, SL chains, current risk cap, cash reconciliation, and interface settings.
3. Verify chunk count/order/size/hashes. Rebuild the linked equity ledger **iteratively**, checking strictly increasing timestamps, missing valuations, high-water marks, drawdown, cash and summary agreement. Never recursively serialize or restore the linked chain.
4. Validate or recover identical historical data. Check the selected start, saved index/timestamp, current bid/ask quote and every equity timestamp against that dataset.
5. For an active replay, require `executionCursor = replay.index + 1` and `equity.count = executionCursor - replay.startIndex`. The last trading and equity timestamps must match the replay timestamp. An unstarted session requires no execution/equity observations.
6. Install history, replay, engine, ledger and serializable UI settings together. `useReplay` installs the saved count **paused**. `useTrading` installs the saved processed cursor and engine directly. No recovery order events or candle transitions are synthesized. The next advance processes only N+1 and later candles.

Chart panes keep their existing chart instances where their layout permits. Data and indicators are rebuilt only from the revealed prefix; horizontal UTC viewport/following state uses the existing synchronizer APIs. A completed replay remains complete and paused, including any open positions or unfilled orders.

## Concurrency and errors

Every save, rename and delete checks persisted revisions in its write transaction. A stale revision fails instead of overwriting a newer checkpoint. BroadcastChannel is advisory: it pauses an older active editor sooner, but correctness does not depend on it. A deleted session cannot be resurrected by a writer holding its old nonzero revision.

Unknown database/snapshot versions, damaged metadata, invalid invariants, changed historical data, unavailable storage and failed transactions produce visible errors. Raw list metadata is guarded before rendering so a corrupt session remains accessible for explicit deletion. Recovery errors preserve original stored data; there is no automatic database reset. Startup offers retry through Resume session, New session, and explicit Delete.

Future database migrations belong in the `onupgradeneeded` old-version switch. Snapshot format migrations should be explicit, validated transformations selected by `schemaVersion`; version 1 has no earlier persisted schema to migrate. Opening a newer database with this app fails without deleting it. Clearing browser storage is a user action, never an error-recovery algorithm.
