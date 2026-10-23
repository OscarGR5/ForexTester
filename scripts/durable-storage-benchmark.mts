import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { diskApiFixture } from '../tests/diskApiFixture.ts'
import { DiskSessionStore } from '../frontend/src/diskSessionStore.ts'
import { SessionStore } from '../frontend/src/sessionStore.ts'
import { historyFingerprint } from '../frontend/src/sessionCodec.ts'
import { sessionHistory, sessionSimulation, manualPermission } from '../frontend/src/sessionFixtures.ts'
import { requestEntry, requestClose } from '../frontend/src/trading.ts'
const nativeFetch = globalThis.fetch, api = await diskApiFixture()
Object.assign(globalThis, { fetch: api.fetch, IDBKeyRange })
const client = new DiskSessionStore(), legacy = new SessionStore(new IDBFactory())
const measure = async <T>(work: () => Promise<T>) => { const start = performance.now(), result = await work(); return { ms: performance.now() - start, result } }
async function diskBytes(path: string): Promise<number> { let size = 0; for (const name of await readdir(path)) { const child = join(path, name), info = await stat(child); size += info.isDirectory() ? await diskBytes(child) : info.size } return size }
try {
  const history = sessionHistory(129600), sim = sessionSimulation(history); sim.observe()
  for (let i = 0; i < 100; i++) { sim.state = requestEntry(sim.state, 'buy', .1, 1.098, manualPermission); sim.observe(); sim.state = requestClose(sim.state, sim.state.positions[0].id, manualPermission); sim.observe() }
  const base = { id: crypto.randomUUID(), name: '90 days / 100 positions', createdAt: new Date().toISOString(), range: { from: history.tradingFrom, to: history.to }, totalCandles: history.bid.length, historyId: await historyFingerprint(history) }
  const historySave = await measure(() => client.cacheHistory(base.historyId, history))
  sim.observe(127599)
  const initial = await measure(() => client.save(base, sim.snapshot(true, 100), null))
  const before = await diskBytes(api.directory)
  const tick = performance.now(); sim.observe(129599); const engine2000Ms = performance.now() - tick
  const incremental = await measure(() => client.save(base, sim.snapshot(), initial.result))
  const oneSessionDiskBytes = await diskBytes(api.directory)
  const restore = await measure(() => client.recover(base.id))
  await api.storage.close()
  // Reopen the same server-owned store with empty in-memory caches.
  const historyCold = await measure(() => api.storage.getHistory(base.historyId))
  await legacy.cacheHistory(base.historyId, history)
  const legacyBase = { ...base, id: crypto.randomUUID() }
  await legacy.save(legacyBase, sim.snapshot(), null)
  const migration = await measure(() => client.migrate(legacy, legacyBase.id, async () => { throw new Error('No live provider') }))
  console.log(JSON.stringify({ environment: 'Node, real localhost HTTP, synced temporary filesystem, deterministic fixture, excludes chart rendering', candles: history.bid.length, positions: sim.state.closed.length,
    historySaveMs: historySave.ms, initial127600PointSaveMs: initial.ms, incremental2000PointSaveMs: incremental.ms, engine2000Ms, restoreMs: restore.ms,
    cold90DayHistoryLoadMs: historyCold.ms, migration90DayMs: migration.ms, oneSessionDiskBytesBeforeIncrement: before, oneSessionDiskBytes, twoSessionDiskBytes: await diskBytes(api.directory),
    historyGzipBytes: (await stat(join(api.directory, 'history', `${base.historyId}.json.gz`))).size, checkpointJsonBytes: Buffer.byteLength(JSON.stringify(incremental.result)), restoredEquityCount: restore.result.ledger.count }, null, 2))
} finally { globalThis.fetch = nativeFetch; await legacy.close(); await api.close() }
