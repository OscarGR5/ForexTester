import { open, mkdir, readFile, readdir, rename, unlink, lstat, realpath } from 'node:fs/promises'
import { resolve, join, dirname, isAbsolute, relative } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { gzip, gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import { projectRoot as repository } from './projectPaths.js'
import { corrupt, historyFingerprint, recordDigest, restoreEquity, sha256, validatedHistory, validateHistoryCheckpoint, validateRecord, equitySuffix } from '../../frontend/src/sessionCodec.js'
import { EQUITY_CHUNK_SIZE, type SessionRecord } from '../../frontend/src/sessionTypes.js'
import type { EquityLedger, EquityPoint } from '../../frontend/src/equity.js'
import type { LoadedHistory } from '../../frontend/src/historyLoader.js'

const compress = promisify(gzip), decompress = promisify(gunzip)
const HASH = /^[a-f0-9]{64}$/
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
export class StorageFailure extends Error { constructor(public status: number, message: string) { super(message) } }
export const conflict = () => new StorageFailure(409, 'This session changed on disk. Resume the saved version before continuing. Unsaved changes were kept in this tab.')
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
}

// One local backend owns a storage directory. The process lock also prevents a
// second backend from bypassing the serialized compare-and-swap below.
export class SessionStorage {
  readonly directory: string
  private initialized: Promise<void> | null = null
  private serial: Promise<unknown> = Promise.resolve()
  private histories = new Map<string, LoadedHistory>()
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
      const m = await this.json(join(this.directory, 'sessions', `${id}.json`)) as Manifest
      if (m.version !== 1 || !Number.isSafeInteger(m.revision) || m.revision < 1 || (m.hash !== null && !HASH.test(m.hash))) throw corrupt()
      return m
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  private async readRecord(id: string): Promise<SessionRecord> {
    const m = await this.pointer(id)
    if (!m?.hash) throw new StorageFailure(404, 'Saved session was not found.')
    const raw = await readFile(join(this.directory, 'checkpoints', `${m.hash}.json`), 'utf8')
    if (await sha256(raw) !== m.hash) throw corrupt()
    const record = JSON.parse(raw) as SessionRecord
    await validateRecord(record)
    if (record.id !== id || record.revision !== m.revision) throw corrupt()
    return record
  }
  private async readChunk(hash: string): Promise<EquityChunk> {
    validHash(hash)
    const raw = await decompress(await readFile(join(this.directory, 'equity', `${hash}.json.gz`)), { maxOutputLength: 2 * 1024 * 1024 })
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
  private async history(id: string, verifyDisk = false): Promise<LoadedHistory> {
    validHash(id)
    const cached = this.histories.get(id)
    if (cached && !verifyDisk) {
      const file = await lstat(join(this.directory, 'history', `${id}.json.gz`))
      if (!file.isFile() || file.size === 0) throw corrupt()
      return cached
    }
    const raw = await decompress(await readFile(join(this.directory, 'history', `${id}.json.gz`)), { maxOutputLength: 64 * 1024 * 1024 })
    const history = validatedHistory(JSON.parse(raw.toString()))
    if (await historyFingerprint(history) !== id) throw corrupt()
    this.rememberHistory(id, history)
    return history
  }
  private rememberHistory(id: string, history: LoadedHistory) { this.histories.set(id, history); if (this.histories.size > 2) this.histories.delete(this.histories.keys().next().value!) }
  private rememberLedger(record: SessionRecord, ledger: EquityLedger) { this.ledgers.set(record.id, { digest: record.digest, ledger }); if (this.ledgers.size > 2) this.ledgers.delete(this.ledgers.keys().next().value!) }
  private async ledger(record: SessionRecord): Promise<EquityLedger> {
    const cached = this.ledgers.get(record.id)
    if (cached?.digest === record.digest) return cached.ledger
    return restoreEquity((await this.chunks(record)).flatMap((chunk) => chunk.points), record.checkpoint.equity, record.checkpoint.trading.account.referenceBalance)
  }
  status() { return this.run(async () => ({ directory: this.directory, authoritative: 'filesystem', schemaVersion: 1 })) }
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
  hasHistory(id: string) { return this.run(async () => { validHash(id); try { await this.history(id, true); return true } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e } }) }
  putHistory(id: string, source: LoadedHistory) { return this.run(async () => {
    validHash(id)
    const history = validatedHistory(source)
    if (await historyFingerprint(history) !== id) throw new StorageFailure(400, 'Historical-data fingerprint mismatch.')
    try { await this.history(id, true); return } catch { /* Replace only with fully validated identical content. */ }
    await this.publish(join(this.directory, 'history', `${id}.json.gz`), await compress(JSON.stringify(history)))
    this.rememberHistory(id, history)
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
