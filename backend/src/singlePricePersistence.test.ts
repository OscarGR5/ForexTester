import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { diskApiFixture } from '../../tests/diskApiFixture.js'
import { fixtureHistory } from '../../tests/databentoFixture.js'
import { DiskSessionStore } from '../../frontend/src/diskSessionStore.js'
import { historyFingerprint, validateHistoryCheckpoint, validatedHistory } from '../../frontend/src/sessionCodec.js'
import { createEquityLedger } from '../../frontend/src/equity.js'
import { createTradingState } from '../../frontend/src/trading.js'
import { sessionSimulation } from '../../frontend/src/sessionFixtures.js'
import { equitySummary, type SessionSnapshot } from '../../frontend/src/sessionTypes.js'
import { historyCandles } from '../../frontend/src/history.js'
let disk: Awaited<ReturnType<typeof diskApiFixture>>
beforeEach(async () => { disk = await diskApiFixture(); vi.stubGlobal('fetch', disk.fetch) })
afterEach(async () => { vi.unstubAllGlobals(); await disk.close() })
it('uploads and restores all 120 days through the real 64 MiB API without paid requests, including mappings and original OHLC', async () => {
  const history = validatedHistory({ ...fixtureHistory('2023-12-02', '2024-03-31', '2024-03-18', true), tradingFrom: '2024-01-01' })
  const id = await historyFingerprint(history), store = new DiskSessionStore(), ledger = createEquityLedger(100000)
  await store.cacheHistory(id, history)
  const snapshot: SessionSnapshot = { ledger, checkpoint: { lifecycle: 'setup', trading: { ...createTradingState(), symbol: '6E' }, equity: equitySummary(ledger), executionCursor: 0,
    replay: { started: false, index: null, timestamp: null, startIndex: 30 * 1440, startTimestamp: Date.parse('2024-01-01'), speed: 100, complete: false, playing: false }, workspace: sessionSimulation().snapshot().checkpoint.workspace } }
  const saved = await store.save({ id: crypto.randomUUID(), name: '120-day single-price dataset', createdAt: new Date().toISOString(), range: { from: history.tradingFrom, to: history.to }, historyId: id, totalCandles: historyCandles(history).length }, snapshot, null)
  const restored = await store.recover(saved.id, async () => { throw Error('Restoration must not download') })
  expect(restored.history).toEqual(history)
  expect(await historyFingerprint(restored.history)).toBe(id)
  expect(saved.symbol).toBe('6E'); expect(saved.totalCandles).toBe(172800)
  validateHistoryCheckpoint(restored.record, restored.history)
  expect(Buffer.byteLength(JSON.stringify(history))).toBeLessThan(64 * 1024 * 1024)
}, 20000)
