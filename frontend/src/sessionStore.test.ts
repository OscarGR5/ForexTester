import { IDBFactory, IDBKeyRange, IDBObjectStore, IDBDatabase } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionStore, RevisionConflict, DATABASE_NAME, storageError } from './sessionStore'
import { historyFingerprint, recordDigest, equitySuffix, restoreEquity } from './sessionCodec'
import { EQUITY_CHUNK_SIZE, type SessionRecord } from './sessionTypes'
import { sessionHistory, sessionSimulation, manualPermission } from './sessionFixtures'
import { cancelEntry, requestEntry, requestClose, modifyStop, updateSetupMetadata } from './trading'
import { journalCsv } from './journalCsv'

let factory: IDBFactory, store: SessionStore
beforeEach(() => { factory = new IDBFactory(); vi.stubGlobal('IDBKeyRange', IDBKeyRange); store = new SessionStore(factory) })
afterEach(async () => { vi.restoreAllMocks(); await store.close(); vi.unstubAllGlobals() })
async function save(sim = sessionSimulation(), previous: SessionRecord | null = null, id = 'session-a', playing = false) {
  const historyId = await historyFingerprint(sim.history)
  return store.save({ id, name: 'London review', createdAt: '2026-10-23T00:00:00.000Z', range: { from: sim.history.tradingFrom, to: sim.history.to }, historyId, totalCandles: sim.history.bid.length }, sim.snapshot(playing), previous)
}
async function recover(record: SessionRecord, sim: ReturnType<typeof sessionSimulation>) {
  await store.cacheHistory(record.historyId, sim.history)
  return store.recover(record.id, async () => sim.history)
}
async function rawEdit(id: string, mutate: (record: SessionRecord) => SessionRecord | Promise<SessionRecord>) {
  const record = (await store.list()).find((r) => r.id === id)!
  const next = await mutate(structuredClone(record))
  const db = await new Promise<IDBDatabase>((resolve) => { const r = factory.open(DATABASE_NAME); r.onsuccess = () => resolve(r.result) })
  await new Promise<void>((resolve) => { const tx = db.transaction('sessions', 'readwrite'); tx.objectStore('sessions').put(next); tx.oncomplete = () => resolve() }); db.close()
}
const enter = (sim: ReturnType<typeof sessionSimulation>, group: string | null = null) => { sim.state = requestEntry(sim.state, 'buy', .1, 1.098, manualPermission, group) }

describe('IndexedDB atomic session checkpoints and recovery', () => {
  it('creates a uniquely identified session with UTC metadata and unstarted replay progress', async () => {
    const sim = sessionSimulation(), record = await save(sim)
    expect(record.revision).toBe(1); expect(record.schemaVersion).toBe(2); expect(record.savedAt).toMatch(/Z$/)
    expect((await store.list()).map((r) => r.id)).toEqual(['session-a'])
    expect((await recover(record, sim)).checkpoint).toEqual(sim.snapshot().checkpoint)
  })
  it.each([false, true])('restores active replay with playing checkpoint %s without mutating the saved execution state', async (playing) => {
    const sim = sessionSimulation(); sim.observe(6)
    const restored = await recover(await save(sim, null, 'session-a', playing), sim)
    expect(restored.checkpoint.executionCursor).toBe(7); expect(restored.ledger.count).toBe(7)
    expect(restored.checkpoint.trading).toEqual(sim.state)
  })
  it('restores completed replay including an open position without forced closure', async () => {
    const sim = sessionSimulation(sessionHistory(5)); sim.observe(); enter(sim); sim.observe(4)
    const record = await save(sim), restored = await recover(record, sim)
    expect(record.status).toBe('complete'); expect(restored.checkpoint.replay.complete).toBe(true)
    expect(restored.checkpoint.trading.positions).toHaveLength(1)
  })
  it('keeps two sessions independent, renames with a revision, and deletes only the selected session', async () => {
    const a = sessionSimulation(), b = sessionSimulation(); a.observe(); enter(a); b.observe(8)
    const ra = await save(a), rb = await save(b, null, 'session-b')
    const renamed = await store.rename(ra.id, 'New name', ra.revision)
    expect(renamed.name).toBe('New name'); expect(renamed.savedAt >= ra.savedAt).toBe(true)
    expect((await recover(rb, b)).checkpoint.trading.pending).toHaveLength(0)
    await store.delete(ra.id, renamed.revision)
    expect((await store.list()).map((r) => r.id)).toEqual(['session-b'])
  })
  it('preserves all account, combined risk and commission configuration', async () => {
    const sim = sessionSimulation(); sim.observe()
    const restored = await recover(await save(sim), sim)
    expect(restored.checkpoint.trading.account).toEqual({ referenceBalance: 10000, maxRiskPercent: 20 })
    expect(restored.checkpoint.trading.commission).toEqual({ roundTripUsdPerLot: 7 })
  })
  it('restores a pending percentage entry without prematurely sizing, filling or charging it', async () => {
    const sim = sessionSimulation(); sim.observe(); sim.state = requestEntry(sim.state, 'buy', { mode: 'risk', riskPercent: 1 }, 1.098, manualPermission)
    const restored = await recover(await save(sim), sim)
    expect(restored.checkpoint.trading.pending).toEqual(sim.state.pending); expect(restored.ledger.cashUsd).toBe(10000)
    expect(restored.checkpoint.trading.nextId).toBe(2); expect(restored.checkpoint.trading.nextSetupId).toBe(2)
  })
  it('restores pending manual close and closes at its next future open exactly once', async () => {
    const sim = sessionSimulation(); sim.observe(); enter(sim); sim.observe(); sim.state = requestClose(sim.state, sim.state.positions[0].id, manualPermission)
    const restored = await recover(await save(sim), sim)
    expect(restored.checkpoint.trading.positions[0].closeRequestedAt).toBe(sim.state.observedTimestamp)
    const continuing = sessionSimulation(sim.history); continuing.state = restored.checkpoint.trading
    // Full hook-level continuation is covered separately; repeated observations
    // remain engine no-ops independently of hook cursor protection.
    const before = continuing.state
    const { observeCandle } = await import('./trading')
    expect(observeCandle(before, sim.history.bid[1], sim.history.ask[1])).toBe(before)
    const after = observeCandle(before, sim.history.bid[2], sim.history.ask[2])
    expect(after.closed).toHaveLength(1); expect(after.closed[0].exitPrice).toBe(sim.history.bid[2].open)
    expect(after.closed[0].totalCommissionUsd).toBeCloseTo(.7)
  })
  it.each([false, true])('preserves two open entries with shared setup %s and original risk denominators', async (grouped) => {
    const sim = sessionSimulation(); sim.observe(); enter(sim); enter(sim, grouped ? sim.state.setups[0].id : null); sim.observe()
    const restored = await recover(await save(sim), sim)
    expect(restored.checkpoint.trading.positions).toEqual(sim.state.positions)
    expect(restored.checkpoint.trading.setups).toHaveLength(grouped ? 1 : 2)
    expect(restored.ledger.cashUsd).toBeCloseTo(9999.3)
  })
  it('preserves SL changes, coverage history, initial risk, closed metadata, gross/net PnL and CSV', async () => {
    const history = sessionHistory(12); history.ask.splice(3, 1)
    // A short needs ask marks and records a missing stop-side quote.
    const sim = sessionSimulation(history); sim.observe(); sim.state = requestEntry(sim.state, 'sell', .1, 1.102, manualPermission); sim.observe()
    const id = sim.state.positions[0].id
    sim.state = modifyStop(sim.state, id, 1.1015, manualPermission); sim.observe(4)
    sim.state = requestClose(sim.state, id, manualPermission); sim.observe()
    sim.state = updateSetupMetadata(sim.state, sim.state.setups[0].id, { title: 'Review', tag: 'London', notes: 'Keep after closure' })
    const restored = await recover(await save(sim), sim)
    expect(restored.checkpoint.trading).toEqual(sim.state)
    expect(restored.checkpoint.trading.closed[0].stopModifications).toHaveLength(1)
    expect(restored.checkpoint.trading.closed[0].coverageWarnings).toHaveLength(1)
    expect(journalCsv(restored.checkpoint.trading)).toEqual(journalCsv(sim.state))
    expect(restored.ledger).toEqual(sim.ledger)
  })
  it('retains same-candle entry and stop fees and reconciles cash exactly after resume', async () => {
    const history = sessionHistory(4); history.bid[1].low = 1.097
    const sim = sessionSimulation(history); sim.observe(); enter(sim); sim.observe()
    const result = await recover(await save(sim), sim), trade = result.checkpoint.trading.closed[0]
    expect(trade.exitTime).toBe(trade.entryTime); expect(trade.totalCommissionUsd).toBeCloseTo(.7)
    expect(result.ledger.cashUsd).toBeCloseTo(10000 + trade.netPnlUsd)
    expect(result.ledger.highWaterMarkUsd).toBe(sim.ledger.highWaterMarkUsd)
    expect(result.ledger.maxDrawdownUsd).toBe(sim.ledger.maxDrawdownUsd)
  })
  it('preserves rejected/cancelled requests, IDs and pending reservations', async () => {
    const sim = sessionSimulation(); sim.observe(); enter(sim); sim.state = cancelEntry(sim.state, sim.state.pending[0].id)
    sim.state = requestEntry(sim.state, 'buy', .1, 1.5, manualPermission); sim.observe()
    const result = await recover(await save(sim), sim)
    expect(result.checkpoint.trading.cancelled).toHaveLength(1); expect(result.checkpoint.trading.rejected).toHaveLength(1)
    expect(result.checkpoint.trading).toEqual(sim.state)
  })
  it('preserves chart layout, all timeframe settings, scopes, UTC viewport and replay speed', async () => {
    const sim = sessionSimulation(); sim.observe()
    const input = sim.snapshot(); input.checkpoint.workspace.indicators[0].M1!.bollinger.length = 41
    input.checkpoint.workspace.indicators[0].M5 = { ...input.checkpoint.workspace.indicators[1].M5! }
    input.checkpoint.replay.speed = 100
    const record = await store.save({ id: 'ui', name: 'UI', createdAt: '2026-10-23T00:00:00.000Z', range: { from: sim.history.tradingFrom, to: sim.history.to }, historyId: await historyFingerprint(sim.history), totalCandles: sim.history.bid.length }, input, null)
    const restored = await recover(record, sim)
    expect(restored.checkpoint.workspace).toEqual(input.checkpoint.workspace); expect(restored.checkpoint.replay.speed).toBe(100)
  })
  it('writes only changed equity chunks and reconstructs a 90-day-sized linked ledger iteratively', async () => {
    const sim = sessionSimulation(sessionHistory(129600)); sim.observe(129000)
    const put = vi.spyOn(IDBObjectStore.prototype, 'put'), record = await save(sim)
    expect(put.mock.calls.length).toBe(Math.ceil(129001 / EQUITY_CHUNK_SIZE) + 1)
    put.mockClear(); sim.observe(129599)
    const latest = await save(sim, record)
    expect(put.mock.calls.length).toBe(3) // two changed chunks and one checkpoint
    const restored = await recover(latest, sim)
    expect(restored.ledger.count).toBe(129600)
    expect(equitySuffix(restored.ledger, 129590)).toEqual(equitySuffix(sim.ledger, 129590))
  }, 20000)
  it('rolls back an interrupted transaction and recovers the previous complete checkpoint', async () => {
    const sim = sessionSimulation(); sim.observe(); const previous = await save(sim); sim.observe(2)
    const original = IDBDatabase.prototype.transaction
    const spy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function(this: IDBDatabase, ...args: Parameters<typeof original>) {
      const tx = original.apply(this, args)
      if (args[1] === 'readwrite') queueMicrotask(() => tx.abort())
      return tx
    })
    await expect(save(sim, previous)).rejects.toThrow(/interrupted/)
    spy.mockRestore()
    expect((await recover(previous, sim)).ledger.count).toBe(1)
  })
  it('reports quota failure without marking a failed write committed', async () => {
    const sim = sessionSimulation(); sim.observe(); const previous = await save(sim); sim.observe()
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError') })
    await expect(save(sim, previous)).rejects.toMatchObject({ name: 'QuotaExceededError' })
    put.mockRestore(); expect((await store.get(previous.id)).revision).toBe(previous.revision)
    expect(storageError(new DOMException('full', 'QuotaExceededError'))).toContain('quota exceeded')
  })
  it('rejects corrupt checksum and preserves the stored original for explicit deletion', async () => {
    const sim = sessionSimulation(); sim.observe(); const record = await save(sim)
    await rawEdit(record.id, (value) => { value.checkpoint.trading.nextId = 0; return value })
    await expect(recover(record, sim)).rejects.toThrow(/corrupt/)
    expect(await store.list()).toHaveLength(1)
    await store.delete(record.id, record.revision); expect(await store.list()).toHaveLength(0)
  })
  it.each(['cursor', 'cash', 'slots', 'risk', 'indicators'])('rejects invalid %s invariants even with a matching checksum', async (kind) => {
    const sim = sessionSimulation(); sim.observe(); enter(sim); sim.observe(); const record = await save(sim)
    await rawEdit(record.id, async (value) => {
      if (kind === 'cursor') value.checkpoint.executionCursor++
      if (kind === 'cash') value.checkpoint.equity.cashUsd++
      if (kind === 'slots') value.checkpoint.trading.positions.push(value.checkpoint.trading.positions[0], value.checkpoint.trading.positions[0])
      if (kind === 'risk') value.checkpoint.trading.positions[0].initialRiskUsd++
      if (kind === 'indicators') delete value.checkpoint.workspace.indicators[0].M1
      value.digest = await recordDigest(value); return value
    })
    await expect(recover(record, sim)).rejects.toThrow(/corrupt/)
  })
  it('detects unsupported snapshot versions without wiping data', async () => {
    const sim = sessionSimulation(), record = await save(sim)
    await rawEdit(record.id, (value) => ({ ...value, schemaVersion: 999 }))
    await expect(recover(record, sim)).rejects.toThrow(/Unsupported/); expect(await store.list()).toHaveLength(1)
  })
  it('rejects newer database versions without wiping the database', async () => {
    await store.close()
    const db = await new Promise<IDBDatabase>((resolve) => { const r = factory.open(DATABASE_NAME, 2); r.onsuccess = () => resolve(r.result) }); db.close()
    await expect(store.list()).rejects.toThrow(/Unsupported IndexedDB version/)
  })
  it('uses cached validated history without redownloading and shares its identity across sessions', async () => {
    const sim = sessionSimulation(), a = await save(sim), b = await save(sim, null, 'b')
    await store.cacheHistory(a.historyId, sim.history)
    const download = vi.fn(async () => { throw new Error('Network must not be used') })
    expect((await store.recover(a.id, download)).history).toEqual(sim.history)
    await store.delete(a.id, a.revision)
    expect((await store.recover(b.id, download)).history).toEqual(sim.history); expect(download).not.toHaveBeenCalled()
  })
  it('refuses missing legacy history without invoking a network fallback', async () => {
    const sim = sessionSimulation(), record = await save(sim)
    const db = await new Promise<IDBDatabase>((resolve) => { const request = factory.open(DATABASE_NAME); request.onsuccess = () => resolve(request.result) })
    await new Promise<void>((resolve) => { const tx = db.transaction('history', 'readwrite'); tx.objectStore('history').delete(record.historyId); tx.oncomplete = () => resolve() })
    const download = vi.fn(async () => sim.history)
    await expect(store.recover(record.id, download)).rejects.toThrow('original Dukascopy provider dataset')
    expect(download).not.toHaveBeenCalled()
    await store.cacheHistory(record.historyId, sim.history)
    expect((await store.recover(record.id, download)).record).toEqual(record)
  })
  it('rejects stale cross-tab saves, rename and delete even without BroadcastChannel', async () => {
    const sim = sessionSimulation(); sim.observe(); const first = await save(sim)
    const other = new SessionStore(factory); sim.observe(); const second = await save(sim, first)
    await expect(other.save(first, sim.snapshot(), first)).rejects.toBeInstanceOf(RevisionConflict)
    await expect(other.rename(first.id, 'stale', first.revision)).rejects.toBeInstanceOf(RevisionConflict)
    await expect(other.delete(first.id, first.revision)).rejects.toBeInstanceOf(RevisionConflict)
    expect((await store.get(first.id)).revision).toBe(second.revision); await other.close()
  })
  it('replaces a restarted ledger atomically while preserving other sessions', async () => {
    const sim = sessionSimulation(); sim.observe(40); enter(sim); const first = await save(sim), other = await save(sim, null, 'other')
    const restarted = sessionSimulation(); restarted.state = { ...restarted.state, session: 8 }; restarted.observe()
    const next = await save(restarted, first)
    expect((await recover(next, restarted)).ledger.count).toBe(1)
    expect((await recover(other, sim)).ledger.count).toBe(41)
  })
  it('detects corrupted equity summary during iterative reconstruction', () => {
    const sim = sessionSimulation(); sim.observe(9)
    expect(() => restoreEquity(equitySuffix(sim.ledger, 0), { ...sim.snapshot().checkpoint.equity, maxDrawdownUsd: 12 }, 10000)).toThrow(/corrupt/)
  })
})

it('handles interrupted read transactions without unhandled rejections or losing the checkpoint', async () => {
  const sim = sessionSimulation(); sim.observe(); const record = await save(sim)
  const original = IDBDatabase.prototype.transaction
  const spy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function(this: IDBDatabase, ...args: Parameters<typeof original>) {
    const tx = original.apply(this, args)
    if (args[1] === 'readonly') queueMicrotask(() => tx.abort())
    return tx
  })
  await expect(store.get(record.id)).rejects.toBeDefined()
  await expect(recover(record, sim)).rejects.toBeDefined()
  spy.mockRestore(); expect((await store.get(record.id)).revision).toBe(record.revision)
})
it('handles malformed history-cache keys as corruption while retaining the original session', async () => {
  const sim = sessionSimulation(), record = await save(sim)
  await rawEdit(record.id, (value) => ({ ...value, historyId: { broken: true } as unknown as string }))
  await expect(recover(record, sim)).rejects.toThrow(/corrupt/)
  expect(await store.list()).toHaveLength(1)
})
it('keeps the old checkpoint if renaming fails synchronously inside a storage transaction', async () => {
  const sim = sessionSimulation(), record = await save(sim)
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError') })
  await expect(store.rename(record.id, 'Uncommitted name', record.revision)).rejects.toMatchObject({ name: 'QuotaExceededError' })
  spy.mockRestore(); expect((await store.get(record.id)).name).toBe(record.name)
})

it('allows explicit deletion of a corrupt revision while protecting a subsequently valid newer checkpoint', async () => {
  const sim = sessionSimulation(), record = await save(sim)
  await rawEdit(record.id, (value) => ({ ...value, revision: { broken: true } as unknown as number }))
  const broken = (await store.list())[0]
  await rawEdit(record.id, async (value) => { value.revision = 2; value.digest = await recordDigest(value); return value })
  await expect(store.delete(record.id, broken.revision)).rejects.toBeInstanceOf(RevisionConflict)
  await rawEdit(record.id, (value) => ({ ...value, revision: { broken: true } as unknown as number }))
  const unreadable = (await store.list())[0]
  await store.delete(record.id, unreadable.revision)
  expect(await store.list()).toHaveLength(0)
})
