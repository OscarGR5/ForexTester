import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { SessionStore } from '../frontend/src/sessionStore.ts'
import { equitySuffix, historyFingerprint } from '../frontend/src/sessionCodec.ts'
import { sessionHistory, sessionSimulation, manualPermission } from '../frontend/src/sessionFixtures.ts'
import { requestEntry, requestClose } from '../frontend/src/trading.ts'
Object.assign(globalThis, { IDBKeyRange })
const factory = new IDBFactory(), store = new SessionStore(factory, 'benchmark')
const ms = async <T>(fn: () => Promise<T>) => { const start = performance.now(), result = await fn(); return { ms: performance.now() - start, result } }
const history = sessionHistory(129600), sim = sessionSimulation(history)
sim.observe()
for (let i = 0; i < 100; i++) {
  sim.state = requestEntry(sim.state, 'buy', .1, 1.098, manualPermission)
  sim.observe(); sim.state = requestClose(sim.state, sim.state.positions[0].id, manualPermission); sim.observe()
}
const identity = await ms(() => historyFingerprint(history))
const base = { id: 'benchmark', name: '100 positions', createdAt: '2026-10-23T00:00:00.000Z', range: { from: history.tradingFrom, to: history.to }, historyId: identity.result, totalCandles: history.bid.length }
const saved = await ms(() => store.save(base, sim.snapshot(), null))
const cache = await ms(() => store.cacheHistory(base.historyId, history))
const restored = await ms(() => store.recover(base.id, async () => { throw Error('Cache missing') }))
const smallPoints = equitySuffix(sim.ledger, 0)
const start = performance.now(); sim.observe(127599); const observationsMs = performance.now() - start
const full = await ms(() => store.save(base, sim.snapshot(), saved.result))
const largeRestore = await ms(() => store.recover(base.id, async () => { throw Error('Cache missing') }))
const engineStart = performance.now(); sim.observe(129599); const batchEngineMs = performance.now() - engineStart
const incremental = await ms(() => store.save(base, sim.snapshot(), full.result))
const finalRestore = await ms(() => store.recover(base.id, async () => { throw Error('Cache missing') }))
const points = equitySuffix(sim.ledger, 0), chunkMeasurements = []
for (const size of [256, 1024, 4096]) {
 const begin = performance.now(); let bytes = 0
 for (let i = 0; i < points.length; i += size) bytes += Buffer.byteLength(JSON.stringify(points.slice(i, i + size)))
 const partialStart = performance.now(), partialBytes = Buffer.byteLength(JSON.stringify(points.slice(-size)))
 chunkMeasurements.push({ chunkSize: size, totalChunks: Math.ceil(points.length / size), encodeAllMs: performance.now() - begin, bytes, encodeTailMs: performance.now() - partialStart, partialBytes })
}
console.log(JSON.stringify({ environment: 'Node + fake-indexeddb; includes structured clone, excludes disk and browser charts', closedPositions: sim.state.closed.length,
 historyFingerprintMs: identity.ms, save100PositionsMs: saved.ms, restore100PositionsMs: restored.ms, cacheHistoryMs: cache.ms,
 save127600ObservationsMs: full.ms, restore127600ObservationsMs: largeRestore.ms, restore129600ObservationsMs: finalRestore.ms, engine127399ObservationsMs: observationsMs,
 incremental2000ObservationCheckpointMs: incremental.ms, engine2000ObservationsMs: batchEngineMs,
 checkpointJsonBytes: Buffer.byteLength(JSON.stringify(incremental.result)), equityJsonBytes: Buffer.byteLength(JSON.stringify(points)), historyJsonBytes: Buffer.byteLength(JSON.stringify(history)),
 smallEquityJsonBytes: Buffer.byteLength(JSON.stringify(smallPoints)), restoredCount: largeRestore.result.ledger.count, chunkMeasurements }, null, 2))
await store.close()
