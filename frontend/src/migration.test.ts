import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { SessionStore } from './sessionStore'
import { DiskSessionStore } from './diskSessionStore'
import { sessionSimulation } from './sessionFixtures'
import { historyFingerprint } from './sessionCodec'
import { requestEntry, requestClose } from './trading'
import { diskApiFixture } from '../../tests/diskApiFixture'

let disk: Awaited<ReturnType<typeof diskApiFixture>>, legacy: SessionStore, client: DiskSessionStore
let fail = false
beforeEach(async () => {
  fail = false; disk = await diskApiFixture({ beforePublish: async (path) => { if (fail && path.includes('/sessions/')) throw new Error('interrupted') } })
  vi.stubGlobal('fetch', disk.fetch); vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  legacy = new SessionStore(new IDBFactory()); client = new DiskSessionStore()
})
afterEach(async () => { await legacy.close(); await disk.close(); vi.unstubAllGlobals() })
async function browserSession() {
  const sim = sessionSimulation(); sim.observe()
  sim.state = requestEntry(sim.state, 'buy', .1, 1.098, { active: true, playing: false, hasFuture: true }); sim.observe(1)
  sim.state = requestClose(sim.state, sim.state.positions[0].id, { active: true, playing: false, hasFuture: true }); sim.observe(2)
  sim.state = { ...sim.state, setups: sim.state.setups.map((s) => ({ ...s, title: 'Legacy setup', notes: 'Keep these notes' })) }
  const base = { id: crypto.randomUUID(), name: 'Legacy journal', createdAt: new Date().toISOString(), range: { from: sim.history.tradingFrom, to: sim.history.to }, historyId: await historyFingerprint(sim.history), totalCandles: sim.history.bid.length }
  await legacy.cacheHistory(base.historyId, sim.history)
  const record = await legacy.save(base, sim.snapshot(), null)
  const next = await legacy.save(base, sim.snapshot(), record)
  return { sim, base, record: next }
}
describe('verified, nondestructive IndexedDB migration', () => {
  it('preserves checkpoint, trades, fees, notes, history and equity without deleting or changing the source', async () => {
    const { record, sim } = await browserSession()
    const result = await client.migrate(legacy, record.id, async () => { throw new Error('No network') })
    expect(result.checkpoint).toEqual(record.checkpoint); expect(result.ledger.count).toBe(sim.ledger.count)
    expect((await legacy.get(record.id)).digest).toBe(record.digest)
    expect(await client.migrationReceipt(record.id)).toMatchObject({ digest: record.digest, targetId: record.id })
    expect((await client.migrate(legacy, record.id, async () => sim.history)).record.digest).toBe(result.record.digest)
  })
  it('does not mark interrupted migrations and safely retries', async () => {
    const { record, sim } = await browserSession(); fail = true
    await expect(client.migrate(legacy, record.id, async () => sim.history)).rejects.toThrow()
    expect(await client.migrationReceipt(record.id)).toBeNull(); expect(await legacy.list()).toHaveLength(1)
    fail = false
    expect((await client.migrate(legacy, record.id, async () => sim.history)).checkpoint).toEqual(record.checkpoint)
  })
  it('retries after the commit response is lost without duplicating a session or fees', async () => {
    const { record, sim } = await browserSession(); let once = true
    vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
      const response = await disk.fetch(path, init)
      if (once && path.endsWith(record.id) && init?.method === 'POST') { once = false; throw new Error('Connection lost after commit') }
      return response
    })
    await expect(client.migrate(legacy, record.id, async () => sim.history)).rejects.toThrow('unavailable')
    expect(await client.migrationReceipt(record.id)).toBeNull()
    const result = await client.migrate(legacy, record.id, async () => sim.history)
    expect(await client.list()).toHaveLength(1); expect(result.checkpoint.trading.closed).toEqual(record.checkpoint.trading.closed)
  })
  it('rejects a different filesystem version and permits an explicit separate import', async () => {
    const { record, sim, base } = await browserSession()
    await client.cacheHistory(base.historyId, sim.history)
    await client.save({ ...base, name: 'Newer disk work' }, sim.snapshot(), null)
    await expect(client.migrate(legacy, record.id, async () => sim.history)).rejects.toThrow('conflict')
    const copied = await client.migrate(legacy, record.id, async () => sim.history, true)
    expect(copied.record.id).not.toBe(record.id); expect(copied.checkpoint).toEqual(record.checkpoint)
    expect((await client.list()).map((r) => r.name).sort()).toEqual(['Legacy journal', 'Newer disk work'])
    expect((await legacy.get(record.id)).digest).toBe(record.digest)
  })
  it('keeps disk sessions available after the entire IndexedDB source is cleared', async () => {
    const { record, sim } = await browserSession(); await client.migrate(legacy, record.id, async () => sim.history)
    await legacy.delete(record.id, record.revision)
    expect(await legacy.list()).toHaveLength(0)
    const differentBrowser = new DiskSessionStore()
    expect((await differentBrowser.recover(record.id)).checkpoint).toEqual(record.checkpoint)
  })
})
