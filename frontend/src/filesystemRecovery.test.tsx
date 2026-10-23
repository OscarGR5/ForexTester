import { rm } from 'node:fs/promises'
import { join } from 'node:path'
// @vitest-environment jsdom
import { StrictMode, act } from 'react'
import { createRoot } from 'react-dom/client'
import { webcrypto } from 'node:crypto'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useReplay } from './useReplay'
import { useTrading } from './useTrading'
import { DiskSessionStore } from './diskSessionStore'
import { diskApiFixture } from '../../tests/diskApiFixture'
import { historyFingerprint, equitySuffix } from './sessionCodec'
import { sessionHistory, sessionSimulation, manualPermission } from './sessionFixtures'
import { requestEntry, requestClose } from './trading'
import { journalCsv } from './journalCsv'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let store: DiskSessionStore
let disk: Awaited<ReturnType<typeof diskApiFixture>>
beforeEach(async () => { disk = await diskApiFixture(); vi.stubGlobal('fetch', disk.fetch); vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('IDBKeyRange', IDBKeyRange); store = new DiskSessionStore() })
afterEach(async () => { vi.useRealTimers(); await disk.close(); vi.unstubAllGlobals() })
async function persisted(sim: ReturnType<typeof sessionSimulation>, speed: 1 | 10 | 100, playing: boolean, repair = false) {
  await store.cacheHistory(await historyFingerprint(sim.history), sim.history)
  const record = await store.save({ id: crypto.randomUUID(), name: 'Recovery', createdAt: '2026-10-23T00:00:00.000Z', range: { from: sim.history.tradingFrom, to: sim.history.to }, historyId: await historyFingerprint(sim.history), totalCandles: sim.history.bid.length }, sim.snapshot(playing, speed), null)
  if (repair) { await rm(join(disk.directory, 'history', `${record.historyId}.json.gz`)); await store.repairHistory(record.id, async () => sim.history) }
  return store.recover(record.id, async () => sim.history)
}
describe('deliberate StrictMode hydration and next-candle execution', () => {
  it.each([1, 10, 100].flatMap((speed) => [false, true].map((repair) => ({ speed: speed as 1 | 10 | 100, repair }))))('restores a previously playing $speed× session paused (repair=$repair) and matches uninterrupted execution without duplicate fees or equity', async ({ speed, repair }) => {
    const history = sessionHistory(205); history.bid[65].low = 1.097
    const sim = sessionSimulation(history); sim.observe()
    sim.state = requestEntry(sim.state, 'buy', .1, 1.098, manualPermission)
    sim.state = requestEntry(sim.state, 'buy', .2, 1.098, manualPermission, sim.state.setups[0].id)
    sim.observe(21)
    const saved = await persisted(sim, speed, true, repair), root = createRoot(document.createElement('div'))
    let replay!: ReturnType<typeof useReplay>, trading!: ReturnType<typeof useTrading>
    function Harness() { replay = useReplay(saved.history.bid, 0, { replay: saved.checkpoint.replay, epoch: saved.checkpoint.trading.session }); trading = useTrading(saved.history, replay, saved); return null }
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      await act(async () => root.render(<StrictMode><Harness /></StrictMode>))
      expect(replay.status).toBe('Paused'); expect(replay.speed).toBe(speed); expect(replay.visible).toHaveLength(22)
      expect(trading.executionCursor).toBe(22); expect(trading.state).toEqual(saved.checkpoint.trading)
      expect(trading.equity.count).toBe(22); expect(trading.equity.cashUsd).toBeCloseTo(9998.95)
      await act(async () => vi.advanceTimersByTime(5000)); expect(replay.count).toBe(22)
      await act(async () => replay.next())
      expect(trading.executionCursor).toBe(23); expect(trading.equity.count).toBe(23); expect(trading.state.positions).toHaveLength(2)
      await act(async () => replay.play())
      for (let tick = 0; tick < Math.ceil(182 / speed); tick++) await act(async () => vi.advanceTimersByTime(250))
      sim.observe(204)
      expect(replay.status).toBe('Complete'); expect(trading.state).toEqual(sim.state)
      expect(equitySuffix(trading.equity, 0)).toEqual(equitySuffix(sim.ledger, 0))
      expect(trading.equity.cashUsd).toBeCloseTo(sim.ledger.cashUsd)
      expect(journalCsv(trading.state)).toBe(journalCsv(sim.state))
    } finally { await act(async () => root.unmount()) }
  })
  it.each(['entry', 'close'] as const)('keeps a pending %s unchanged during hydration, then executes only at N+1', async (kind) => {
    const sim = sessionSimulation(); sim.observe(); sim.state = requestEntry(sim.state, 'buy', .1, 1.098, manualPermission)
    if (kind === 'close') { sim.observe(); sim.state = requestClose(sim.state, sim.state.positions[0].id, manualPermission) }
    const saved = await persisted(sim, 10, false), root = createRoot(document.createElement('div'))
    let replay!: ReturnType<typeof useReplay>, trading!: ReturnType<typeof useTrading>
    function Harness() { replay = useReplay(saved.history.bid, 0, { replay: saved.checkpoint.replay, epoch: saved.checkpoint.trading.session }); trading = useTrading(saved.history, replay, saved); return null }
    try {
      await act(async () => root.render(<StrictMode><Harness /></StrictMode>))
      expect(trading.state).toEqual(saved.checkpoint.trading)
      await act(async () => replay.next())
      const next = saved.checkpoint.replay.index! + 1
      if (kind === 'entry') { expect(trading.state.positions[0].entryTime).toBe(saved.history.bid[next].timestamp); expect(trading.state.pending).toHaveLength(0) }
      else { expect(trading.state.closed[0].exitTime).toBe(saved.history.bid[next].timestamp); expect(trading.state.closed[0].totalCommissionUsd).toBeCloseTo(.7) }
      expect(trading.equity.count).toBe(saved.ledger.count + 1)
    } finally { await act(async () => root.unmount()) }
  })
  it('restores final-candle replay paused with positions available for review and CSV', async () => {
    const sim = sessionSimulation(sessionHistory(3)); sim.observe(); sim.state = requestEntry(sim.state, 'buy', .1, 1.098, manualPermission); sim.observe(2)
    const saved = await persisted(sim, 100, false), root = createRoot(document.createElement('div'))
    let replay!: ReturnType<typeof useReplay>, trading!: ReturnType<typeof useTrading>
    function Harness() { replay = useReplay(saved.history.bid, 0, { replay: saved.checkpoint.replay, epoch: saved.checkpoint.trading.session }); trading = useTrading(saved.history, replay, saved); return null }
    try {
      await act(async () => root.render(<StrictMode><Harness /></StrictMode>))
      expect(replay.status).toBe('Complete'); expect(replay.playing).toBe(false); expect(replay.canNext).toBe(false)
      expect(trading.state.positions).toHaveLength(1); expect(journalCsv(trading.state)).toContain('open')
    } finally { await act(async () => root.unmount()) }
  })
})
