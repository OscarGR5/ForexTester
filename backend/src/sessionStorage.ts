import { open, mkdir, readFile, readdir, rename, unlink, lstat, realpath } from 'node:fs/promises'
import { resolve, join, dirname, isAbsolute, relative } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { gzip, gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import { projectRoot as repository } from './projectPaths.js'
import { corrupt, historyFingerprint, recordDigest, restoreEquity, sha256, validatedHistory, validateHistoryCheckpoint, validateRecord, equitySuffix } from '../../frontend/src/sessionCodec.js'
import type { StorageCode, CleanupCategory, CleanupPreview, CleanupResult } from '../../frontend/src/storageProtocol.js'
import { EQUITY_CHUNK_SIZE, RECORD_VERSION, type SessionRecord } from '../../frontend/src/sessionTypes.js'
import type { EquityLedger, EquityPoint } from '../../frontend/src/equity.js'
import type { LoadedHistory } from '../../frontend/src/historyLoader.js'

const compress = promisify(gzip), decompress = promisify(gunzip)
const HASH = /^[a-f0-9]{64}$/
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
export class StorageFailure extends Error { constructor(public status: number, message: string, public code: StorageCode = 'STORAGE_REQUEST_INVALID') { super(message) } }
export const conflict = () => new StorageFailure(409, 'This session changed on disk. Resume the saved version before continuing. Unsaved changes were kept in this tab.', 'SESSION_CONFLICT')
export function validId(id: string) { if (!ID.test(id)) throw new StorageFailure(400, 'Invalid session ID.') }
export function validHash(hash: string) { if (!HASH.test(hash)) throw new StorageFailure(400, 'Invalid content fingerprint.') }
export function dataDirectory(env = process.env, home = homedir()): string {
  const path = resolve(env.FOREXTESTER_DATA_DIR || join(env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home, '.local/share'), 'forextester'))
  const inside = relative(repository, path)
  if (!inside || !(inside === '..' || inside.startsWith('../') || isAbsolute(inside))) throw new Error('FOREXTESTER_DATA_DIR must be outside the Git repository.')
  return path
}
export interface EquityChunk { hash: string; points: EquityPoint[] }
interface Manifest { version: 1; revision: number; hash: string | null; migration?: { digest: string; revision: number } }
export interface StorageOptions {
  directory?: string
  // Deterministic fault injection at durability boundaries; never configured through HTTP.
  beforePublish?: (path: string) => Promise<void>
  beforeRemove?: (path: string) => Promise<void>
}

// One local backend owns a storage directory. The process lock also prevents a
// second backend from bypassing the serialized compare-and-swap below.
export class SessionStorage {
  readonly directory: string
  private initialized: Promise<void> | null = null
  private serial: Promise<unknown> = Promise.resolve()
  private histories = new Map<string, { history: LoadedHistory; signature: string }>()
  private ledgers = new Map<string, { digest: string; ledger: EquityLedger }>()
  private ownsLock = false
  private closing: Promise<void> | null = null
  constructor(private options: StorageOptions = {}) { this.directory = options.directory ? resolve(options.directory) : dataDirectory() }
  private async initialize() {
    if (!this.initialized) this.initialized = (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const canonical = await realpath(this.directory), inside = relative(repository, canonical)
      if (!inside || !(inside === '..' || inside.startsWith('../') || isAbsolute(inside))) throw new Error('Storage must be outside the Git repository, including symlinks.')
      await this.syncDirectory(dirname(this.directory))
      for (const folder of ['sessions', 'checkpoints', 'equity', 'history', 'imports']) {
        const path = join(this.directory, folder)
        await mkdir(path, { recursive: true, mode: 0o700 })
        if ((await lstat(path)).isSymbolicLink()) throw new Error('Storage subdirectories must not be symbolic links.')
      }
      if (this.ownsLock) return
      // Serialize stale-lock inspection and replacement across backend
      // processes. Without this guard, two starters could unlink each other's
      // newly acquired owner lock after both observed the same dead PID.
      const guardPath = join(this.directory, 'writer-init.lock')
      let guard
      try { guard = await open(guardPath, 'wx', 0o600) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Another backend is initializing storage. Retry; if it crashed, stop all backends before removing writer-init.lock.')
        throw error
      }
      try {
        const lock = join(this.directory, 'writer.lock')
        try {
          const owner = JSON.parse(await readFile(lock, 'utf8')) as { pid: number }
          if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('Storage writer.lock is unreadable. Stop all backends before removing it.')
          try { process.kill(owner.pid, 0); throw new Error('Another backend owns this storage directory.') }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
          await unlink(lock)
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        const handle = await open(lock, 'wx', 0o600)
        try { await handle.writeFile(JSON.stringify({ pid: process.pid })); await handle.sync(); this.ownsLock = true }
        catch (error) { await unlink(lock); throw error }
        finally { await handle.close() }
        await this.syncDirectory(this.directory)
      } finally { await guard.close(); await unlink(guardPath); await this.syncDirectory(this.directory) }
      // Unpublished .tmp files and unreferenced immutable blobs are harmless.
      // Do not remove data automatically after an interrupted save.
    })().catch((error) => { this.initialized = null; throw error })
    return this.initialized
  }
  private run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.serial.then(async () => { await this.initialize(); return operation() })
    this.serial = next.catch(() => {})
    return next
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closing = (async () => {
      await this.serial
      if (this.ownsLock) {
        this.ownsLock = false
        await unlink(join(this.directory, 'writer.lock')); await this.syncDirectory(this.directory)
        this.initialized = null; this.histories.clear(); this.ledgers.clear()
      }
    })().finally(() => { this.closing = null })
    return this.closing
  }
  private async syncDirectory(path: string) { const handle = await open(path, 'r'); try { await handle.sync() } finally { await handle.close() } }
  private async publish(path: string, bytes: Uint8Array) {
    const temporary = `${path}.${randomUUID()}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    // A failure here leaves the preceding manifest and every object it names intact.
    await this.options.beforePublish?.(path)
    await rename(temporary, path)
    await this.syncDirectory(dirname(path))
  }
  private async json(path: string): Promise<unknown> { return JSON.parse(await readFile(path, 'utf8')) }
  private async pointer(id: string): Promise<Manifest | null> {
    validId(id)
    try {
      const path = join(this.directory, 'sessions', `${id}.json`)
      await this.regularFile(path)
      const m = await this.json(path) as Manifest
      if (m.version !== 1 || !Number.isSafeInteger(m.revision) || m.revision < 1 || (m.hash !== null && !HASH.test(m.hash))) throw corrupt()
      return m
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  private async readRecord(id: string): Promise<SessionRecord> {
    const m = await this.pointer(id)
    if (!m?.hash) throw new StorageFailure(404, 'Saved session was not found.', 'SESSION_NOT_FOUND')
    const path = join(this.directory, 'checkpoints', `${m.hash}.json`)
    await this.regularFile(path)
    const raw = await readFile(path, 'utf8')
    if (await sha256(raw) !== m.hash) throw corrupt()
    const record = JSON.parse(raw) as SessionRecord
    await validateRecord(record)
    if (record.id !== id || record.revision !== m.revision) throw corrupt()
    return record
  }
  private async readChunk(hash: string): Promise<EquityChunk> {
    validHash(hash)
    const path = join(this.directory, 'equity', `${hash}.json.gz`)
    await this.regularFile(path)
    const raw = await decompress(await readFile(path), { maxOutputLength: 2 * 1024 * 1024 })
    if (await sha256(raw.toString()) !== hash) throw corrupt()
    const points = JSON.parse(raw.toString()) as EquityPoint[]
    if (!Array.isArray(points) || points.length < 1 || points.length > EQUITY_CHUNK_SIZE) throw corrupt()
    return { hash, points }
  }
  private async chunks(record: SessionRecord): Promise<EquityChunk[]> {
    if (record.chunkHashes.length !== Math.ceil(record.checkpoint.equity.count / EQUITY_CHUNK_SIZE)) throw corrupt()
    const chunks = await Promise.all(record.chunkHashes.map((hash) => this.readChunk(hash)))
    for (const [index, chunk] of chunks.entries()) if (chunk.points.length !== Math.min(EQUITY_CHUNK_SIZE, record.checkpoint.equity.count - index * EQUITY_CHUNK_SIZE)) throw corrupt()
    return chunks
  }
  private async regularFile(path: string) {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new StorageFailure(503, 'Unsafe storage file type. Original files were kept.', 'STORAGE_UNSAFE_PATH')
    return info
  }
  private async history(id: string, verifyDisk = false): Promise<LoadedHistory> {
    validHash(id)
    const path = join(this.directory, 'history', `${id}.json.gz`)
    let bytes: Buffer, signature: string
    const parent = await lstat(dirname(path))
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new StorageFailure(503, 'Historical storage directory is unavailable or unsafe.', 'STORAGE_UNSAFE_PATH')
    // Only ENOENT for this object means missing history. I/O and permissions
    // stay outside the content-validation catch and must never offer repair.
    try {
      const info = await this.regularFile(path)
      signature = `${info.dev}/${info.ino}/${info.size}/${info.mtimeMs}/${info.ctimeMs}`
      const cached = this.histories.get(id)
      if (cached && !verifyDisk && cached.signature === signature) return cached.history
      bytes = await readFile(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new StorageFailure(404, 'Historical data is missing. Repair historical data to resume this session.', 'HISTORY_MISSING')
      throw error
    }
    let history: LoadedHistory
    try {
      const raw = await decompress(bytes, { maxOutputLength: 64 * 1024 * 1024 })
      history = validatedHistory(JSON.parse(raw.toString()))
      if (await historyFingerprint(history) !== id) throw corrupt()
    } catch {
      this.histories.delete(id)
      throw new StorageFailure(422, 'Historical data is corrupted. Repair historical data to resume this session; the checkpoint and trading records were kept.', 'HISTORY_CORRUPT')
    }
    this.histories.set(id, { history, signature })
    if (this.histories.size > 2) this.histories.delete(this.histories.keys().next().value!)
    return history
  }
  private rememberLedger(record: SessionRecord, ledger: EquityLedger) { this.ledgers.set(record.id, { digest: record.digest, ledger }); if (this.ledgers.size > 2) this.ledgers.delete(this.ledgers.keys().next().value!) }
  private async ledger(record: SessionRecord): Promise<EquityLedger> {
    const cached = this.ledgers.get(record.id)
    if (cached?.digest === record.digest) return cached.ledger
    return restoreEquity((await this.chunks(record)).flatMap((chunk) => chunk.points), record.checkpoint.equity, record.checkpoint.trading.account.referenceBalance)
  }
  status() { return this.run(async () => ({ directory: this.directory, authoritative: 'filesystem', schemaVersion: RECORD_VERSION })) }
  list() { return this.run(async () => {
    const records: SessionRecord[] = [], errors: { id: string; error: string; revision: number | null }[] = []
    for (const name of await readdir(join(this.directory, 'sessions'))) {
      if (!name.endsWith('.json') || !ID.test(name.slice(0, -5))) continue
      const id = name.slice(0, -5)
      try { if ((await this.pointer(id))?.hash) records.push(await this.readRecord(id)) }
      catch {
        let revision: number | null = null
        try { revision = (await this.pointer(id))?.revision ?? null } catch { /* Keep damaged manifests for manual recovery. */ }
        errors.push({ id, revision, error: 'Unreadable disk session. Original files were kept.' })
      }
    }
    return { sessions: records.sort((a, b) => b.savedAt.localeCompare(a.savedAt)), errors }
  }) }
  get(id: string) { return this.run(() => this.readRecord(id)) }
  restore(id: string) { return this.run(async () => { const record = await this.readRecord(id); return { record, chunks: await this.chunks(record) } }) }
  getHistory(id: string) { return this.run(() => this.history(id, true)) }
  hasHistory(id: string) { return this.run(async () => { await this.history(id, true); return true }) }
  putHistory(id: string, source: LoadedHistory) { return this.run(async () => {
    validHash(id)
    let history: LoadedHistory
    try { history = validatedHistory(source) }
    catch { throw new StorageFailure(400, 'Replacement historical data contains invalid observations or range boundaries.', 'HISTORY_INVALID') }
    if (await historyFingerprint(history) !== id) throw new StorageFailure(409, 'The provider returned different historical data. Replacement was rejected; retry later or restore the original dataset from a separate backup while the backend is stopped.', 'HISTORY_FINGERPRINT_MISMATCH')
    try { await this.history(id, true); return }
    catch (error) {
      if (!(error instanceof StorageFailure) || !['HISTORY_MISSING', 'HISTORY_CORRUPT'].includes(error.code)) throw error
    }
    // The existing object survives until the fully validated, synced replacement
    // is ready for atomic publication. All sessions keep the same history ID.
    await this.publish(join(this.directory, 'history', `${id}.json.gz`), await compress(JSON.stringify(history)))
    this.histories.delete(id)
  }) }
  save(record: SessionRecord, changed: EquityChunk[], expectedRevision: number, migration?: Manifest['migration']) { return this.run(async () => {
    validId(record.id)
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || record.revision !== expectedRevision + 1 || record.name.length > 200) throw new StorageFailure(400, 'Invalid checkpoint revision or name.')
    await validateRecord(record)
    const existing = await this.pointer(record.id)
    // A deletion tombstone is deliberately never treated as a new ID.
    if ((existing?.revision ?? 0) !== expectedRevision || (existing && existing.hash === null)) throw conflict()
    if (migration && (expectedRevision !== 0 || !HASH.test(migration.digest) || !Number.isSafeInteger(migration.revision) || migration.revision < 1)) throw new StorageFailure(400, 'Invalid migration receipt.')
    const history = await this.history(record.historyId)
    validateHistoryCheckpoint(record, history)
    const previous = existing ? await this.readRecord(record.id) : null
    if (previous && (record.historyId !== previous.historyId || record.createdAt !== previous.createdAt)) throw new StorageFailure(400, 'A session cannot change its dataset or creation time.')
    const reset = !previous || previous.checkpoint.trading.session !== record.checkpoint.trading.session || record.checkpoint.equity.count < previous.checkpoint.equity.count || previous.checkpoint.trading.account.referenceBalance !== record.checkpoint.trading.account.referenceBalance
    const oldCount = reset ? 0 : previous!.checkpoint.equity.count
    const from = record.checkpoint.equity.count === oldCount ? oldCount : Math.floor(oldCount / EQUITY_CHUNK_SIZE) * EQUITY_CHUNK_SIZE
    const expectedHashes = reset ? [] : previous!.chunkHashes.slice(0, Math.ceil(from / EQUITY_CHUNK_SIZE))
    if (record.chunkHashes.length !== Math.ceil(record.checkpoint.equity.count / EQUITY_CHUNK_SIZE)) throw corrupt()
    for (let i = 0; i < Math.floor(from / EQUITY_CHUNK_SIZE); i++) if (expectedHashes[i] !== record.chunkHashes[i]) throw corrupt()
    const supplied = new Map<string, EquityPoint[]>()
    for (const chunk of changed) {
      validHash(chunk.hash)
      if (!Array.isArray(chunk.points) || chunk.points.length < 1 || chunk.points.length > EQUITY_CHUNK_SIZE || await sha256(JSON.stringify(chunk.points)) !== chunk.hash) throw new StorageFailure(400, 'Equity chunk hash mismatch.')
      supplied.set(chunk.hash, chunk.points)
    }
    const suffix: EquityPoint[] = []
    if (record.checkpoint.equity.count > from) for (let index = from / EQUITY_CHUNK_SIZE; index < record.chunkHashes.length; index++) {
      const points = supplied.get(record.chunkHashes[index]) ?? (await this.readChunk(record.chunkHashes[index])).points
      if (points.length !== Math.min(EQUITY_CHUNK_SIZE, record.checkpoint.equity.count - index * EQUITY_CHUNK_SIZE)) throw corrupt()
      suffix.push(...points)
    }
    let initial: EquityLedger | undefined
    if (!reset) {
      initial = await this.ledger(previous!)
      if (oldCount > from && JSON.stringify(suffix.slice(0, oldCount - from)) !== JSON.stringify(equitySuffix(initial, from))) throw corrupt()
      // With no new observations every hash must remain identical.
      if (record.checkpoint.equity.count === oldCount && JSON.stringify(record.chunkHashes) !== JSON.stringify(previous!.chunkHashes)) throw corrupt()
    }
    const newPoints = suffix.slice(oldCount - from)
    const ledger = restoreEquity(newPoints, record.checkpoint.equity, record.checkpoint.trading.account.referenceBalance, initial)
    for (const [index, point] of newPoints.entries()) if (history.bid[record.checkpoint.replay.startIndex + oldCount + index]?.timestamp !== point.timestamp) throw corrupt()
    if (ledger.tail && ledger.tail.point.timestamp !== record.checkpoint.replay.timestamp) throw corrupt()
    for (const chunk of changed) {
      if (!record.chunkHashes.includes(chunk.hash)) throw new StorageFailure(400, 'Unreferenced equity chunk.')
      const path = join(this.directory, 'equity', `${chunk.hash}.json.gz`)
      try { await this.readChunk(chunk.hash) } catch { await this.publish(path, await compress(JSON.stringify(chunk.points))) }
    }
    const raw = JSON.stringify(record), hash = await sha256(raw)
    await this.publish(join(this.directory, 'checkpoints', `${hash}.json`), Buffer.from(raw))
    const manifest: Manifest = { version: 1, revision: record.revision, hash, ...(migration || existing?.migration ? { migration: migration ?? existing!.migration } : {}) }
    await this.publish(join(this.directory, 'sessions', `${record.id}.json`), Buffer.from(JSON.stringify(manifest)))
    this.rememberLedger(record, ledger)
    return record
  }) }
  private emptyPreview(): CleanupPreview {
    return { safe: true, candidateFiles: 0, reclaimableBytes: 0, categories: {
      checkpoints: { files: 0, bytes: 0 }, equity: { files: 0, bytes: 0 }, history: { files: 0, bytes: 0 }, temporary: { files: 0, bytes: 0 },
    } }
  }
  private async cleanupPlan() {
    const preview = this.emptyPreview()
    const candidates: { path: string; file: string; category: CleanupCategory; bytes: number; dev: number; ino: number; mtimeMs: number; ctimeMs: number }[] = []
    try {
      // Validate directory types on every invocation, even after initialization.
      for (const folder of ['sessions', 'checkpoints', 'equity', 'history', 'imports']) {
        const info = await lstat(join(this.directory, folder))
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe managed directory.')
      }
      const live = new Set<string>()
      for (const name of await readdir(join(this.directory, 'sessions'))) {
        if (!ID.test(name.slice(0, -5)) || !name.endsWith('.json')) continue
        const id = name.slice(0, -5), manifest = await this.pointer(id)
        if (!manifest) throw corrupt()
        if (!manifest.hash) continue // Tombstone remains; its old blobs are eligible.
        const record = await this.readRecord(id)
        // Read from disk, bypassing caches, before claiming cleanup is safe.
        const chunks = await this.chunks(record), history = await this.history(record.historyId, true)
        const points = chunks.flatMap((chunk) => chunk.points)
        const ledger = restoreEquity(points, record.checkpoint.equity, record.checkpoint.trading.account.referenceBalance)
        validateHistoryCheckpoint(record, history)
        if (points.some((point, index) => point.timestamp !== history.bid[record.checkpoint.replay.startIndex + index]?.timestamp) || (ledger.tail && ledger.tail.point.timestamp !== record.checkpoint.replay.timestamp)) throw corrupt()
        live.add(`checkpoints/${manifest.hash}.json`)
        live.add(`history/${record.historyId}.json.gz`)
        for (const hash of record.chunkHashes) live.add(`equity/${hash}.json.gz`)
      }
      const hash = '[a-f0-9]{64}', uuid = '[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}'
      const cutoff = Date.now() - 7 * 86_400_000
      for (const folder of ['sessions', 'checkpoints', 'equity', 'history', 'imports'] as const) {
        const object = folder === 'sessions' || folder === 'imports' ? `${uuid}\\.json` : `${hash}\\.json${folder === 'checkpoints' ? '' : '\\.gz'}`
        const normal = new RegExp(`^${object}$`), temporary = new RegExp(`^${object}\\.${uuid}\\.tmp$`)
        for (const name of await readdir(join(this.directory, folder))) {
          const path = join(this.directory, folder, name), info = await this.regularFile(path)
          const file = `${folder}/${name}`, temp = temporary.test(name)
          if (!temp && (!normal.test(name) || folder === 'sessions' || folder === 'imports')) continue
          if (live.has(file) || info.mtimeMs > cutoff) continue
          const category: CleanupCategory = temp ? 'temporary' : folder as CleanupCategory
          candidates.push({ path, file, category, bytes: info.size, dev: info.dev, ino: info.ino, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs })
          preview.categories[category].files++; preview.categories[category].bytes += info.size
          preview.candidateFiles++; preview.reclaimableBytes += info.size
        }
      }
    } catch {
      // Discard partial knowledge, never sweep based on an incomplete mark.
      return { preview: { ...this.emptyPreview(), safe: false, code: 'CLEANUP_UNSAFE' as const,
        error: 'Cleanup refused: an active session or managed storage file could not be safely validated. Repair storage and preview again. No files were deleted.' }, candidates: [] }
    }
    return { preview, candidates }
  }
  previewCleanup() { return this.run(async () => (await this.cleanupPlan()).preview) }
  cleanup() { return this.run(async (): Promise<CleanupResult> => {
    // A preview is informational. Recompute reachability under the writer queue.
    const { preview, candidates } = await this.cleanupPlan()
    const result: CleanupResult = { ...preview, removedFiles: 0, reclaimedBytes: 0, remainingFiles: preview.candidateFiles, failures: [] }
    if (!preview.safe) return result
    for (const candidate of candidates) {
      try {
        await this.options.beforeRemove?.(candidate.path)
        const parent = await lstat(dirname(candidate.path))
        if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Unsafe directory.')
        const info = await this.regularFile(candidate.path)
        if (info.dev !== candidate.dev || info.ino !== candidate.ino || info.size !== candidate.bytes || info.mtimeMs !== candidate.mtimeMs || info.ctimeMs !== candidate.ctimeMs) throw new Error('File changed since validation.')
        await unlink(candidate.path)
        result.removedFiles++; result.reclaimedBytes += candidate.bytes; result.remainingFiles--
        await this.syncDirectory(dirname(candidate.path))
      } catch {
        result.failures.push({ file: candidate.file, error: 'Could not confirm removal. Preview and retry cleanup.' })
      }
    }
    this.histories.clear(); this.ledgers.clear()
    return result
  }) }
  migration(id: string) { return this.run(async () => {
    validId(id)
    try { return await this.json(join(this.directory, 'imports', `${id}.json`)) as { digest: string; revision: number; targetId: string } }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }) }
  confirmMigration(id: string, targetId: string, revision: number, sourceRevision: number, digest: string) { return this.run(async () => {
    validId(id); validId(targetId); validHash(digest)
    const record = await this.readRecord(targetId)
    if (record.revision !== revision) throw conflict()
    if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 1 || await recordDigest({ ...record, id, revision: sourceRevision }) !== digest) throw new StorageFailure(409, 'Migration checkpoint does not match the browser source.')
    await this.ledger(record)
    validateHistoryCheckpoint(record, await this.history(record.historyId))
    await this.publish(join(this.directory, 'imports', `${id}.json`), Buffer.from(JSON.stringify({ digest, revision: sourceRevision, targetId })))
  }) }
  rename(id: string, name: string, revision: number) { return this.run(async () => {
    if (typeof name !== 'string' || !name.trim() || name.length > 200) throw new StorageFailure(400, 'Enter a session name of 1 to 200 characters.')
    const record = await this.readRecord(id)
    if (record.revision !== revision) throw conflict()
    const next = { ...record, name: name.trim(), revision: revision + 1, savedAt: new Date().toISOString() }
    next.digest = await recordDigest(next)
    const raw = JSON.stringify(next), hash = await sha256(raw)
    await this.publish(join(this.directory, 'checkpoints', `${hash}.json`), Buffer.from(raw))
    await this.publish(join(this.directory, 'sessions', `${id}.json`), Buffer.from(JSON.stringify({ ...await this.pointer(id), revision: next.revision, hash })))
    this.ledgers.delete(id)
    return next
  }) }
  delete(id: string, revision: number) { return this.run(async () => {
    const pointer = await this.pointer(id)
    if (!pointer?.hash || pointer.revision !== revision) throw conflict()
    await this.publish(join(this.directory, 'sessions', `${id}.json`), Buffer.from(JSON.stringify({ ...pointer, revision: revision + 1, hash: null })))
    this.ledgers.delete(id)
    // Retain immutable objects for recovery and other sessions. No risky GC on deletion.
  }) }
}
