import { historyCandles } from './history.js'
import type { EquityPoint } from './equity.js'
import type { LoadedHistory } from './historyLoader.js'
import { corrupt, equitySuffix, historyFingerprint, recordDigest, restoreEquity, sha256, validateHistoryCheckpoint, validatedHistory, validateRecord } from './sessionCodec.js'
import { EQUITY_CHUNK_SIZE, STORAGE_VERSION, RECORD_VERSION, lifecycleOf, type Hydration, type SessionRecord, type SessionSnapshot } from './sessionTypes.js'

export const DATABASE_NAME = 'forextester-sessions'
export class RevisionConflict extends Error {
  constructor() { super('This session changed in another tab or browser. Editing is paused to protect the newer checkpoint; unsaved changes in this tab were not committed. Resume the saved session to continue, or create a new session.') }
}
export function storageError(error: unknown): string {
  if (error instanceof Error && error.name === 'QuotaExceededError') return 'Browser storage quota exceeded. This checkpoint was not saved. Free browser storage and try Save now; export your journal separately.'
  return error instanceof Error ? error.message : 'Browser storage is unavailable. This checkpoint was not saved.'
}
function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { operation.onsuccess = () => resolve(operation.result); operation.onerror = () => reject(operation.error) })
}
function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('Storage transaction was interrupted. The previous checkpoint was kept.'))
    transaction.onerror = () => { /* The abort event reports the authoritative transaction failure. */ }
  })
}
const chunkRange = (id: string) => IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])

export class SessionStore {
  private opening: Promise<IDBDatabase> | null = null
  constructor(private factory: IDBFactory | undefined = globalThis.indexedDB, private name = DATABASE_NAME) {}
  private open(): Promise<IDBDatabase> {
    if (!this.opening) this.opening = new Promise<IDBDatabase>((resolve, reject) => {
      if (!this.factory) { reject(new Error('IndexedDB is unavailable in this browser. Sessions cannot be saved.')); return }
      const operation = this.factory.open(this.name, STORAGE_VERSION)
      operation.onupgradeneeded = (event) => {
        const db = operation.result
        // Future migrations belong here, selected by event.oldVersion. Never
        // delete an existing store to recover from an error.
        if (event.oldVersion === 0) {
          db.createObjectStore('sessions', { keyPath: 'id' })
          db.createObjectStore('equity', { keyPath: ['sessionId', 'index'] })
          db.createObjectStore('history', { keyPath: 'id' })
        }
      }
      operation.onsuccess = () => {
        const db = operation.result
        db.onversionchange = () => { db.close(); this.opening = null }
        resolve(db)
      }
      operation.onerror = () => reject(operation.error?.name === 'VersionError'
        ? new Error('Unsupported IndexedDB version. Open this session with a compatible application version; stored data was kept.') : operation.error)
      operation.onblocked = () => reject(new Error('Storage upgrade is blocked by another tab. Close other ForexTester tabs and retry.'))
    }).catch((error) => { this.opening = null; throw error })
    return this.opening
  }
  async close() { if (this.opening) (await this.opening).close(); this.opening = null }
  async list(): Promise<SessionRecord[]> {
    const db = await this.open(), tx = db.transaction('sessions', 'readonly'), done = committed(tx)
    const [rows] = await Promise.all([request<SessionRecord[]>(tx.objectStore('sessions').getAll()), done])
    return rows.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)))
  }
  async get(id: string): Promise<SessionRecord> {
    const db = await this.open(), tx = db.transaction('sessions', 'readonly'), done = committed(tx)
    const [record] = await Promise.all([request<SessionRecord | undefined>(tx.objectStore('sessions').get(id)), done])
    if (!record) throw new Error('Saved session was not found. It may have been deleted in another tab.')
    await validateRecord(record)
    return record
  }
  async cacheHistory(id: string, history: LoadedHistory): Promise<void> {
    const db = await this.open()
    const read = db.transaction('history', 'readonly'), readDone = committed(read)
    const [exists] = await Promise.all([request(read.objectStore('history').getKey(id)), readDone])
    if (exists !== undefined) return
    const tx = db.transaction('history', 'readwrite'), done = committed(tx)
    try { tx.objectStore('history').put({ id, history }) } catch (error) { tx.abort(); await done.catch(() => {}); throw error }
    await done
  }
  async save(base: Pick<SessionRecord, 'id' | 'name' | 'createdAt' | 'range' | 'historyId' | 'totalCandles'>,
    snapshot: SessionSnapshot, previous: SessionRecord | null): Promise<SessionRecord> {
    const { checkpoint, ledger } = snapshot
    const reset = !previous || previous.checkpoint.trading.session !== checkpoint.trading.session || ledger.count < previous.checkpoint.equity.count
    const oldCount = reset ? 0 : previous!.checkpoint.equity.count
    const from = ledger.count === oldCount ? ledger.count : Math.floor(oldCount / EQUITY_CHUNK_SIZE) * EQUITY_CHUNK_SIZE
    const suffix = equitySuffix(ledger, from)
    const changed: { sessionId: string; index: number; points: EquityPoint[]; hash: string }[] = []
    const hashes = reset ? [] : previous!.chunkHashes.slice()
    for (let offset = 0; offset < suffix.length; offset += EQUITY_CHUNK_SIZE) {
      const points = suffix.slice(offset, offset + EQUITY_CHUNK_SIZE), hash = await sha256(JSON.stringify(points))
      const index = (from + offset) / EQUITY_CHUNK_SIZE
      hashes[index] = hash; changed.push({ sessionId: base.id, index, points, hash })
    }
    const record: SessionRecord = { ...base, name: base.name.trim(), savedAt: new Date().toISOString(), schemaVersion: RECORD_VERSION,
      symbol: checkpoint.trading.symbol ?? 'EURUSD', revision: (previous?.revision ?? 0) + 1,
      status: checkpoint.replay.complete ? 'complete' : checkpoint.replay.playing ? 'in-progress' : 'paused',
      completedSetups: checkpoint.trading.setups.filter((setup) => checkpoint.trading.closed.some((p) => p.setupId === setup.id) && ![...checkpoint.trading.pending, ...checkpoint.trading.positions].some((p) => p.setupId === setup.id)).length,
      checkpoint: { ...checkpoint, lifecycle: lifecycleOf(checkpoint) }, chunkHashes: hashes, digest: '' }
    record.digest = await recordDigest(record)
    await validateRecord(record)
    const db = await this.open(), tx = db.transaction(['sessions', 'equity'], 'readwrite'), done = committed(tx)
    let conflict = false, writeError: unknown = null
    const sessions = tx.objectStore('sessions'), equity = tx.objectStore('equity')
    const read = sessions.get(base.id)
    read.onsuccess = () => {
      const existing = read.result as SessionRecord | undefined
      if ((existing?.revision ?? 0) !== (previous?.revision ?? 0)) { conflict = true; tx.abort(); return }
      try {
        if (reset) equity.delete(chunkRange(base.id))
        for (const chunk of changed) equity.put(chunk)
        sessions.put(record)
      } catch (error) { writeError = error; tx.abort() }
    }
    try { await done } catch (error) { if (conflict) throw new RevisionConflict(); throw writeError ?? error }
    return record
  }
  async rename(id: string, name: string, revision: number): Promise<SessionRecord> {
    if (!name.trim()) throw new Error('Enter a session name.')
    const record = await this.get(id)
    if (record.revision !== revision) throw new RevisionConflict()
    const next = { ...record, name: name.trim(), savedAt: new Date().toISOString(), revision: revision + 1 }
    next.digest = await recordDigest(next)
    await this.replaceOrDelete(id, revision, next)
    return next
  }
  private async replaceOrDelete(id: string, revision: number, next: SessionRecord | null) {
    const db = await this.open(), tx = db.transaction(['sessions', 'equity', 'history'], 'readwrite'), done = committed(tx)
    let conflict = false, writeError: unknown = null
    const sessions = tx.objectStore('sessions'), read = sessions.get(id)
    read.onsuccess = () => {
      const actualRevision: unknown = read.result?.revision
      const validRevision = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      // Explicit deletion must remain available for unreadable revisions. A
      // newer valid revision still wins over any stale/corrupt list metadata.
      const deletingCorruptRevision = next === null && !validRevision(actualRevision) && !validRevision(revision)
      if (!read.result || (actualRevision !== revision && !deletingCorruptRevision)) { conflict = true; tx.abort(); return }
      try {
        if (next) sessions.put(next)
        else {
          const historyId = read.result.historyId
          sessions.delete(id); tx.objectStore('equity').delete(chunkRange(id))
          // Collect only unreferenced history, within the same transaction as
          // deletion so another session cannot lose shared candle data.
          const remaining = sessions.getAll()
          remaining.onsuccess = () => {
            try {
              if (!remaining.result.some((row: SessionRecord) => row.historyId === historyId) && typeof historyId === 'string') tx.objectStore('history').delete(historyId)
            } catch (error) { writeError = error; tx.abort() }
          }
        }
      } catch (error) { writeError = error; tx.abort() }
    }
    try { await done } catch (error) { if (conflict) throw new RevisionConflict(); throw writeError ?? error }
  }
  async delete(id: string, revision: number) { await this.replaceOrDelete(id, revision, null) }
  async recover(id: string, download: (range: SessionRecord['range']) => Promise<LoadedHistory>): Promise<Hydration & { history: LoadedHistory; cacheWarning: string | null }> {
    // Read checkpoint and its chunks in ONE snapshot transaction. A concurrent
    // writer must not make a valid checkpoint look corrupt during recovery.
    const db = await this.open(), tx = db.transaction(['sessions', 'equity', 'history'], 'readonly'), done = committed(tx)
    const row = request(tx.objectStore('sessions').get(id))
    const chunks = request(tx.objectStore('equity').getAll(chunkRange(id)))
    let cached: { history: LoadedHistory } | undefined
    row.then((record: SessionRecord | undefined) => {
      if (record && typeof record.historyId === 'string' && /^[a-f0-9]{64}$/.test(record.historyId)) {
        const read = tx.objectStore('history').get(record.historyId)
        read.onsuccess = () => { cached = read.result }
      }
    }).catch(() => { /* The transaction and row promises below report read failures. */ })
    const [record, storedChunks] = await Promise.all([row, chunks, done]) as [SessionRecord | undefined, { index: number; points: EquityPoint[]; hash: string }[], void]
    if (!record) throw new Error('Saved session was not found. It may have been deleted in another tab.')
    await validateRecord(record)
    if (storedChunks.length !== record.chunkHashes.length || storedChunks.length !== Math.ceil(record.checkpoint.equity.count / EQUITY_CHUNK_SIZE)) throw corrupt()
    const points: EquityPoint[] = []
    for (const [index, chunk] of storedChunks.entries()) {
      if (!Array.isArray(chunk.points) || chunk.index !== index || chunk.hash !== record.chunkHashes[index] || await sha256(JSON.stringify(chunk.points)) !== chunk.hash ||
        chunk.points.length !== Math.min(EQUITY_CHUNK_SIZE, record.checkpoint.equity.count - points.length)) throw corrupt()
      for (const point of chunk.points) points.push(point)
    }
    const ledger = restoreEquity(points, record.checkpoint.equity, record.checkpoint.trading.account.referenceBalance)
    let history: LoadedHistory | null = null, cacheWarning: string | null = null
    if (cached) {
      try {
        const candidate = validatedHistory(cached.history)
        if (await historyFingerprint(candidate) === record.historyId) history = candidate
      } catch { /* Invalid cache can be recovered only with matching redownloaded data. */ }
    }
    if (!history) {
      if (record.symbol === 'EURUSD') throw new Error('The original Dukascopy provider dataset is required. Recover its stored history from backup; Databento cannot regenerate it.')
      history = validatedHistory(await download(record.range))
      if (await historyFingerprint(history) !== record.historyId) throw new Error('Historical-data conflict: recovered bid/ask candles differ from this session’s saved fingerprint. Recovery stopped; original trades were kept. Retry with the original dataset.')
      // Replace a damaged cache only after verifying against the saved identity.
      const write = db.transaction('history', 'readwrite'), writeDone = committed(write)
      try {
        try { write.objectStore('history').put({ id: record.historyId, history }) } catch (error) { write.abort(); await writeDone.catch(() => {}); throw error }
        await writeDone
      } catch (error) { cacheWarning = `History cache unavailable: ${storageError(error)} Recovery will need a matching download next time.` }
    }
    validateHistoryCheckpoint(record, history)
    if (points.length && (points[0].timestamp !== historyCandles(history)[record.checkpoint.replay.startIndex]?.timestamp || points.at(-1)!.timestamp !== record.checkpoint.replay.timestamp ||
      points.some((point, index) => point.timestamp !== historyCandles(history!)[record.checkpoint.replay.startIndex + index]?.timestamp))) throw corrupt()
    return { record, checkpoint: record.checkpoint, ledger, history, cacheWarning }
  }
}
