// @vitest-environment jsdom
import { StrictMode, act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { webcrypto } from 'node:crypto'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TradingDock } from './TradingDock'
import { useReplay } from './useReplay'
import { useTrading } from './useTrading'
import { sessionHistory, sessionSimulation } from './sessionFixtures'
import { localHistory } from '../../tests/localHistoryFixture'
import { stopOverlays } from './stopOverlays'
import { historyCandles, type HistoryResponse, type Timeframe } from './history'
import { SessionStore } from './sessionStore'
import { historyFingerprint } from './sessionCodec'
import { equitySummary, type Hydration, type SessionSnapshot } from './sessionTypes'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let host: HTMLDivElement, root: ReturnType<typeof createRoot>, store: SessionStore
let replay: ReturnType<typeof useReplay>, trading: ReturnType<typeof useTrading>
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  store = new SessionStore(new IDBFactory())
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); await store.close(); vi.useRealTimers(); vi.unstubAllGlobals() })

async function mount(history: HistoryResponse = sessionHistory(), restored?: Hydration, strict = true) {
  const source = historyCandles(history)
  function Harness() {
    const [timeframe, setTimeframe] = useState<Timeframe>('M5')
    replay = useReplay(source, 0, restored ? { replay: restored.checkpoint.replay, epoch: restored.checkpoint.trading.session } : null)
    trading = useTrading(history, replay, restored)
    return <>
      <select aria-label="Timeframe" value={timeframe} onChange={e => setTimeframe(e.target.value as Timeframe)}>{['M5', 'M15', 'H1'].map(t => <option key={t}>{t}</option>)}</select>
      <button onClick={() => replay.navigate('forward', timeframe)}>Advance timeframe</button>
      <TradingDock trading={trading} draft={null} setDraft={() => {}} stops={stopOverlays(trading.state)} onConfirm={() => {}} />
    </>
  }
  await act(async () => root.render(strict ? <StrictMode><Harness /></StrictMode> : <Harness />))
  if (!restored) {
    await act(async () => trading.configureCommission({ roundTripUsdPerLot: 7 }))
    await act(async () => replay.start())
  }
}
const clickAll = () => act(async () => host.querySelector<HTMLButtonElement>('.close-all')!.click())
async function enterTwo() {
  await act(async () => { trading.enter('buy', .1, 1.098); trading.enter('buy', .2, 1.098) })
  await act(async () => replay.next())
  expect(trading.state.positions).toHaveLength(2)
}
function expectQueued() {
  expect(trading.state.positions.map(p => p.closeRequestedAt)).toEqual([replay.timestamp, replay.timestamp])
  expect([...host.querySelectorAll('.active-positions button')].map(b => b.textContent)).toEqual(['Close pending', 'Close pending'])
  expect(host.querySelector<HTMLButtonElement>('.close-all')!.disabled).toBe(true)
}

it.each([false, true])('queues both closes in one hook action (StrictMode %s)', async strict => {
  await mount(sessionHistory(), undefined, strict); await enterTwo()
  const version = trading.actionVersion, entryPrices = trading.state.positions.map(p => p.entryPrice)
  await clickAll(); expectQueued()
  expect(trading.actionVersion).toBe(version + 1)
  expect(trading.state.closed).toHaveLength(0)
  await act(async () => replay.next())
  expect(trading.state.positions).toHaveLength(0)
  expect(trading.state.closed).toHaveLength(2)
  trading.state.closed.forEach((p, i) => {
    expect(p.exitTime).toBe(replay.timestamp)
    expect(p.exitPrice).toBe(sessionHistory().bid[2].open)
    expect(p.netPnlUsd).toBeCloseTo((p.exitPrice - entryPrices[i]) * 100_000 * p.lots - p.lots * 7, 8)
  })
  expect(trading.equity.cashUsd).toBeCloseTo(100_000 + trading.state.closed.reduce((sum, p) => sum + p.netPnlUsd, 0), 8)
})

it('preserves individual Close and queues the remaining position with Close all', async () => {
  await mount(); await enterTwo()
  const first = trading.state.positions[0]
  await act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="Close ${first.id}"]`)!.click())
  const queued = trading.state.positions[0]
  expect(trading.state.positions[1].closeRequestedAt).toBeNull()
  await clickAll(); expectQueued()
  expect(trading.state.positions[0]).toBe(queued)
  await act(async () => replay.next())
  expect(trading.state.closed).toHaveLength(2)
})

it('keeps a pending entry untouched through the real hook and does not close it when it fills', async () => {
  await mount()
  await act(async () => trading.enter('buy', .1, 1.098))
  await act(async () => replay.next())
  await act(async () => trading.enter('buy', .2, 1.098))
  const pending = trading.state.pending
  await clickAll()
  expect(trading.state.pending).toBe(pending)
  await act(async () => replay.next())
  expect(trading.state.closed).toHaveLength(1)
  expect(trading.state.positions).toHaveLength(1)
  expect(trading.state.positions[0].id).toBe(pending[0].id)
  expect(trading.state.positions[0].closeRequestedAt).toBeNull()
})

it('closes local single-price positions after replay advances and timeframe changes, at the first intervening M1 open', async () => {
  const bid = sessionHistory().bid
  const history = { ...localHistory(), candles: bid }
  await mount(history); await enterTwo()
  for (const timeframe of ['M5', 'M15', 'H1']) {
    await act(async () => {
      const select = host.querySelector('select')!; select.value = timeframe
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
  }
  const cursor = trading.executionCursor, equityCount = trading.equity.count
  expect(cursor).toBe(60)
  await clickAll(); expectQueued()
  const queued = trading.state.positions
  await act(async () => { trading.closeAll(); trading.closeAll(); trading.closeAll() })
  expect(trading.state.positions).toBe(queued)
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
  expect(trading.executionCursor).toBe(120)
  expect(trading.equity.count).toBe(equityCount + 60)
  expect(trading.state.positions).toHaveLength(0)
  expect(trading.state.closed.map(p => [p.exitTime, p.exitPrice])).toEqual([[bid[cursor].timestamp, bid[cursor].open], [bid[cursor].timestamp, bid[cursor].open]])
  for (const p of trading.state.closed) expect(p.netPnlUsd).toBeCloseTo((p.exitPrice - p.entryPrice) * 100_000 * p.lots - p.lots * 7, 8)
})

it('blocks the bulk hook action during playback and historical review', async () => {
  await mount(); await enterTwo()
  await act(async () => replay.play())
  const positions = trading.state.positions
  await act(async () => trading.closeAll())
  expect(trading.state.positions).toBe(positions)
  await act(async () => replay.pause())
  await act(async () => replay.navigate('forward', 'M5'))
  await act(async () => replay.navigate('forward', 'M5'))
  await act(async () => replay.navigate('backward', 'M5'))
  expect(replay.reviewing).toBe(true)
  await act(async () => trading.closeAll())
  expect(trading.state.positions.every(p => p.closeRequestedAt === null)).toBe(true)
})

it('saves both real queued requests, restores them paused, and executes once on the next M1', async () => {
  const history = sessionHistory()
  await mount(history); await enterTwo(); await clickAll()
  const snapshot: SessionSnapshot = { ledger: trading.equity, checkpoint: {
    ...sessionSimulation(history).snapshot().checkpoint, lifecycle: 'trading',
    replay: { started: true, index: replay.count - 1, timestamp: replay.timestamp, startIndex: replay.startIndex, startTimestamp: history.bid[0].timestamp, speed: 1, complete: false, playing: false },
    trading: trading.state, executionCursor: trading.executionCursor, equity: equitySummary(trading.equity),
  } }
  const historyId = await historyFingerprint(history)
  await store.cacheHistory(historyId, history)
  const record = await store.save({ id: crypto.randomUUID(), name: 'Bulk close recovery', createdAt: '2026-10-31T00:00:00.000Z', range: { from: history.tradingFrom, to: history.to }, historyId, totalCandles: history.bid.length }, snapshot, null)
  const saved = await store.recover(record.id, async () => history)
  await act(async () => root.unmount()); root = createRoot(host)
  await mount(saved.history, saved)
  expectQueued(); expect(trading.state).toEqual(snapshot.checkpoint.trading)
  expect(trading.equity.count).toBe(snapshot.ledger.count)
  await act(async () => replay.next())
  expect(trading.state.closed).toHaveLength(2)
  expect(trading.state.positions).toHaveLength(0)
  expect(trading.state.closed.every(p => p.exitTime === history.bid[2].timestamp)).toBe(true)
  await act(async () => replay.next())
  expect(trading.state.closed).toHaveLength(2)
  expect(trading.equity.cashUsd).toBeCloseTo(100_000 + trading.state.closed.reduce((sum, p) => sum + p.netPnlUsd, 0), 8)
})
