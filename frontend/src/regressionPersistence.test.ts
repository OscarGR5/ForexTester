import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { diskApiFixture } from '../../tests/diskApiFixture'
import { DiskSessionStore } from './diskSessionStore'
import { historyFingerprint, recordDigest, validateRecord, validateHistoryCheckpoint } from './sessionCodec'
import { sessionHistory, sessionSimulation } from './sessionFixtures'
import { RegressionCalculator } from './regressionChannel'
import { historyCandles } from './history'

let disk: Awaited<ReturnType<typeof diskApiFixture>>
beforeEach(async () => { disk = await diskApiFixture(); vi.stubGlobal('fetch', disk.fetch) })
afterEach(async () => { vi.unstubAllGlobals(); await disk.close() })
async function fixture(anchor?: number | null, index = 10) {
  const client = new DiskSessionStore(), sim = sessionSimulation(sessionHistory(30)); sim.observe(index)
  const snapshot = sim.snapshot()
  if (anchor !== undefined) snapshot.checkpoint.regressionAnchor = anchor
  const base = { id: crypto.randomUUID(), name: 'Regression channel', createdAt: new Date().toISOString(),
    range: { from: sim.history.tradingFrom, to: sim.history.to }, historyId: await historyFingerprint(sim.history), totalCandles: sim.history.bid.length }
  await client.cacheHistory(base.historyId, sim.history)
  const record = await client.save(base, snapshot, null)
  return { client, sim, record }
}
it('restores the durable M1 anchor and identical calculation without relying on UI preferences', async () => {
  const history = sessionHistory(), anchor = history.bid[4].timestamp
  const { client, sim, record } = await fixture(anchor), restored = await client.recover(record.id)
  expect(restored.checkpoint.regressionAnchor).toBe(anchor)
  expect(new RegressionCalculator(historyCandles(restored.history)).update(anchor, restored.checkpoint.replay.index! + 1))
    .toEqual(new RegressionCalculator(sim.history.bid).update(anchor, 11))
  expect(restored.checkpoint.trading).toEqual(sim.state)
})
it('keeps anchors independent between sessions and loads legacy records without an anchor', async () => {
  const a = await fixture(sessionHistory().bid[2].timestamp), b = await fixture(), c = await fixture(null)
  expect((await a.client.recover(a.record.id)).checkpoint.regressionAnchor).toBe(sessionHistory().bid[2].timestamp)
  expect((await b.client.recover(b.record.id)).checkpoint.regressionAnchor).toBeUndefined()
  expect((await c.client.recover(c.record.id)).checkpoint.regressionAnchor).toBeNull()
})
it('preserves an anchor beyond a restarted replay cutoff while hiding its channel', async () => {
  const anchor = sessionHistory().bid[8].timestamp, { client, record } = await fixture(anchor, 2)
  const restored = await client.recover(record.id)
  expect(restored.checkpoint.regressionAnchor).toBe(anchor)
  expect(new RegressionCalculator(historyCandles(restored.history)).update(anchor, 3)).toBeNull()
})
it.each([-1, 1.5, NaN, Infinity, 'wrong', Date.UTC(2024, 0, 1) + 1])('rejects an invalid saved anchor %s', async anchor => {
  const { record } = await fixture()
  const altered = structuredClone(record)
  altered.checkpoint.regressionAnchor = anchor as number
  altered.digest = await recordDigest(altered)
  await expect(validateRecord(altered)).rejects.toThrow('corrupt')
})
it('rejects an anchor that is not an original M1 timestamp in the saved history', async () => {
  const { record, sim } = await fixture()
  record.checkpoint.regressionAnchor = sim.history.bid.at(-1)!.timestamp + 60000
  expect(() => validateHistoryCheckpoint(record, sim.history)).toThrow('corrupt')
})
