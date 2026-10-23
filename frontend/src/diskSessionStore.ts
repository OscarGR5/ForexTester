import { StorageApiError, fingerprintMismatch, type StorageCode, type CleanupPreview, type CleanupResult } from './storageProtocol.js'
import { historyRequestBody } from './historyRequestBody.js'
import type { EquityPoint } from './equity.js'
import type { LoadedHistory } from './historyLoader.js'
import { corrupt, equitySuffix, historyFingerprint, recordDigest, restoreEquity, sha256, validateHistoryCheckpoint, validatedHistory, validateRecord } from './sessionCodec.js'
import { EQUITY_CHUNK_SIZE, STORAGE_VERSION, type Hydration, type SessionRecord, type SessionSnapshot } from './sessionTypes.js'
import { RevisionConflict, SessionStore } from './sessionStore.js'

export class DiskSessionStore {
  listErrors: { id: string; error: string; revision: number | null }[] = []
  async call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    let response: Response
    try { response = await fetch(`/api/storage${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? body instanceof Blob ? body : JSON.stringify(body) : undefined, cache: 'no-store' }) }
    catch { throw new StorageApiError('STORAGE_UNAVAILABLE', 'Local storage backend is unavailable. Keep this tab open and retry; unsaved changes remain in memory.') }
    const value = await response.json().catch(() => null)
    if (response.status === 409 && (!value?.code || value.code === 'SESSION_CONFLICT')) throw new RevisionConflict()
    if (!response.ok) throw new StorageApiError(value?.code ?? 'STORAGE_UNAVAILABLE', value?.error ?? `Filesystem request failed (HTTP ${response.status}).`)
    return value as T
  }
  status() { return this.call<{ directory: string }>('/status') }
  async list(): Promise<SessionRecord[]> {
    const result = await this.call<{ sessions: SessionRecord[]; errors: { id: string; error: string; revision: number | null }[] }>('/sessions')
    this.listErrors = result.errors
    return result.sessions
  }
  async cacheHistory(id: string, history: LoadedHistory) {
    let response: Response
    try { response = await fetch(`/api/storage/history/${id}`, { method: 'HEAD', cache: 'no-store' }) }
    catch { throw new StorageApiError('STORAGE_UNAVAILABLE', 'Local storage backend is unavailable. Keep this tab open and retry; unsaved changes remain in memory.') }
    if (response.ok) return
    const code = response.headers.get('X-Storage-Error-Code') as StorageCode | null
    if (!['HISTORY_MISSING', 'HISTORY_CORRUPT'].includes(code ?? '')) throw new StorageApiError(code ?? 'STORAGE_UNAVAILABLE', 'Could not verify historical data on disk. Check the local backend and retry Save now.')
    const body = typeof Worker !== 'undefined' && history.bid.length + history.ask.length > 8192 ? await historyRequestBody(history) : history
    await this.call(`/history/${id}`, 'PUT', body)
  }
  previewCleanup() { return this.call<CleanupPreview>('/cleanup') }
  cleanup() { return this.call<CleanupResult>('/cleanup', 'POST', { confirm: true }) }
  async repairHistory(id: string, download: (range: SessionRecord['range']) => Promise<LoadedHistory>) {
    const { record } = await this.call<{ record: SessionRecord }>(`/sessions/${id}`)
    await validateRecord(record)
    const history = validatedHistory(await download(record.range))
    if (await historyFingerprint(history) !== record.historyId) throw fingerprintMismatch()
    const body = typeof Worker !== 'undefined' && history.bid.length + history.ask.length > 8192 ? await historyRequestBody(history) : history
    await this.call(`/history/${record.historyId}`, 'PUT', body)
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
    const record: SessionRecord = { ...base, name: base.name.trim(), savedAt: new Date().toISOString(), schemaVersion: STORAGE_VERSION,
      symbol: 'EURUSD', revision: (previous?.revision ?? 0) + 1,
      status: checkpoint.replay.complete ? 'complete' : checkpoint.replay.playing ? 'in-progress' : 'paused',
      completedSetups: checkpoint.trading.setups.filter((setup) => checkpoint.trading.closed.some((p) => p.setupId === setup.id) && ![...checkpoint.trading.pending, ...checkpoint.trading.positions].some((p) => p.setupId === setup.id)).length,
      checkpoint, chunkHashes: hashes, digest: '' }
    record.digest = await recordDigest(record)
    await validateRecord(record)
    return this.call<SessionRecord>(`/sessions/${base.id}${previous ? '/checkpoint' : ''}`, previous ? 'PUT' : 'POST', { record, chunks: changed.map(({ hash, points }) => ({ hash, points })), expectedRevision: previous?.revision ?? 0 })
  }
  async rename(id: string, name: string, revision: number) { return this.call<SessionRecord>(`/sessions/${id}`, 'PATCH', { name, revision }) }
  async delete(id: string, revision: number) { await this.call(`/sessions/${id}`, 'DELETE', { revision }) }
  async recover(id: string, _download?: (range: SessionRecord['range']) => Promise<LoadedHistory>): Promise<Hydration & { history: LoadedHistory; cacheWarning: null }> {
    const { record, chunks } = await this.call<{ record: SessionRecord; chunks: { hash: string; points: EquityPoint[] }[] }>(`/sessions/${id}`)
    await validateRecord(record)
    if (chunks.length !== record.chunkHashes.length || chunks.length !== Math.ceil(record.checkpoint.equity.count / EQUITY_CHUNK_SIZE)) throw corrupt()
    const points: EquityPoint[] = []
    for (const [index, chunk] of chunks.entries()) {
      if (chunk.hash !== record.chunkHashes[index] || await sha256(JSON.stringify(chunk.points)) !== chunk.hash || chunk.points.length !== Math.min(EQUITY_CHUNK_SIZE, record.checkpoint.equity.count - points.length)) throw corrupt()
      for (const point of chunk.points) points.push(point)
    }
    const ledger = restoreEquity(points, record.checkpoint.equity, record.checkpoint.trading.account.referenceBalance)
    const history = validatedHistory(await this.call<LoadedHistory>(`/history/${record.historyId}`))
    if (await historyFingerprint(history) !== record.historyId) throw new StorageApiError('HISTORY_CORRUPT', 'Historical data failed fingerprint verification. Repair historical data to resume.')
    validateHistoryCheckpoint(record, history)
    if (points.some((point, index) => point.timestamp !== history.bid[record.checkpoint.replay.startIndex + index]?.timestamp) || (ledger.tail && ledger.tail.point.timestamp !== record.checkpoint.replay.timestamp)) throw corrupt()
    return { record, checkpoint: record.checkpoint, ledger, history, cacheWarning: null }
  }
  async migrationReceipt(id: string) { return this.call<{ digest: string; revision: number; targetId: string } | null>(`/sessions/${id}/migration`) }
  async migrate(legacy: SessionStore, id: string, download: (range: SessionRecord['range']) => Promise<LoadedHistory>, asCopy = false) {
    const source = await legacy.recover(id, download)
    const receipt = await this.migrationReceipt(id)
    if (!asCopy && receipt && receipt.digest !== source.record.digest) throw new Error('Migration conflict: this browser copy changed after import. Keep both versions; import as a separate session.')
    if (!asCopy && receipt) return this.recover(receipt.targetId)
    const targetId = asCopy ? crypto.randomUUID() : id
    let stored: SessionRecord | null = null
    try { const result = await this.call<{ record: SessionRecord }>(`/sessions/${targetId}`); stored = result.record }
    catch (error) { if (!(error instanceof Error) || !error.message.includes('not found')) throw error }
    if (!stored) {
      await this.cacheHistory(source.record.historyId, source.history)
      const next = { ...source.record, id: targetId, revision: 1 }
      next.digest = await recordDigest(next)
      const points = equitySuffix(source.ledger, 0), chunks: { hash: string; points: EquityPoint[] }[] = []
      for (let i = 0; i < points.length; i += EQUITY_CHUNK_SIZE) chunks.push({ hash: next.chunkHashes[i / EQUITY_CHUNK_SIZE], points: points.slice(i, i + EQUITY_CHUNK_SIZE) })
      stored = await this.call<SessionRecord>(`/sessions/${targetId}`, 'POST', { record: next, chunks, expectedRevision: 0 })
    }
    // Retry after an interrupted response only when disk reproduces the exact
    // original digest. Never replace a different filesystem checkpoint.
    if (await recordDigest({ ...stored, id, revision: source.record.revision }) !== source.record.digest) throw new Error('Migration conflict: a different checkpoint already exists on disk. Import as a separate session to preserve both.')
    const verified = await this.recover(targetId)
    await this.call(`/sessions/${id}/migration`, 'POST', { targetId, revision: verified.record.revision, sourceRevision: source.record.revision, digest: source.record.digest })
    return verified
  }
}
