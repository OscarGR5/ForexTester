// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { nextCandleIndex, previousCandleIndex } from './candleNavigation'
import { TIMEFRAME_MS, type Candle, type Timeframe, type SinglePriceHistory } from './history'
import { useReplay } from './useReplay'
import { useTrading } from './useTrading'
import { observeCandle, requestAutomaticEntry } from './trading'
import { createEquityLedger, recordEquity } from './equity'
import { fixtureHistory } from '../../tests/databentoFixture'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const base = Date.UTC(2024, 0, 9)
const candles = (count: number): Candle[] => Array.from({ length: count }, (_, i) => ({ timestamp: base + i * 60000, open: 1.1, high: 1.1005, low: 1.0995, close: 1.1001 }))
it.each(['M5', 'M15', 'H1', 'H4', 'D1'] as Timeframe[])('completes a partial %s bucket, then exactly one subsequent bucket', timeframe => {
  const size = TIMEFRAME_MS[timeframe] / 60000, source = candles(size * 3)
  expect(nextCandleIndex(source, 1, timeframe)).toBe(size - 1)
  expect(nextCandleIndex(source, size - 1, timeframe)).toBe(size * 2 - 1)
  expect(previousCandleIndex(source, size * 2 - 1, timeframe)).toBe(size - 1)
  expect(previousCandleIndex(source, size - 1, timeframe)).toBe(size - 1)
})
it('steps actual observations over missing minutes, weekends and the session end', () => {
  const source = ['2024-01-12T21:56Z', '2024-01-12T21:58Z', '2024-01-14T22:02Z', '2024-01-14T22:04Z', '2024-01-14T22:07Z'].map(value => ({ ...candles(1)[0], timestamp: Date.parse(value) }))
  expect(nextCandleIndex(source, 0, 'M5')).toBe(1)
  expect(nextCandleIndex(source, 1, 'M5')).toBe(3)
  expect(nextCandleIndex(source, 3, 'M5')).toBe(4)
  expect(nextCandleIndex(source, 4, 'M5')).toBe(4)
  expect(previousCandleIndex(source, 3, 'M5')).toBe(1)
  expect(previousCandleIndex(source, 3, 'M5', 2)).toBe(3)
})

it('processes every intervening M1, including fills, stops, equity and commissions, then reviews without execution mutation', async () => {
  const source = candles(130).map((c, i) => ({ ...c, low: i === 17 ? 1.098 : c.low, volume: '10', instrumentId: 101 }))
  const history: SinglePriceHistory = { ...fixtureHistory('2024-01-09', '2024-01-10'), candles: source }
  let replay!: ReturnType<typeof useReplay>, trading!: ReturnType<typeof useTrading>
  function Harness() { replay = useReplay(source); trading = useTrading(history, replay); return null }
  const root = createRoot(document.createElement('div'))
  try {
    await act(async () => root.render(<StrictMode><Harness /></StrictMode>))
    await act(async () => trading.configureCommission({ roundTripUsdPerLot: 7 }))
    await act(async () => replay.start())
    const start = trading.state, permission = trading.permission
    await act(async () => { trading.enterAutomatic('buy', { mode: 'risk', riskPercent: 1 }, 1.099); trading.enterAutomatic('buy', { mode: 'risk', riskPercent: .5 }, 1.098) })
    // Independently execute the same observations one minute at a time.
    let expected = requestAutomaticEntry(start, 'buy', { mode: 'risk', riskPercent: 1 }, 1.099, permission)
    expected = requestAutomaticEntry(expected, 'buy', { mode: 'risk', riskPercent: .5 }, 1.098, permission)
    let ledger = trading.equity
    for (let i = 1; i < 60; i++) { const before = expected; expected = observeCandle(expected, source[i], undefined, 'single'); ledger = recordEquity(ledger, before, expected) }
    await act(async () => replay.navigate('forward', 'H1'))
    expect(replay.timestamp).toBe(source[59].timestamp)
    expect(trading.executionCursor).toBe(60)
    expect(trading.state).toEqual(expected)
    expect(trading.equity).toEqual(ledger)
    expect(trading.state.closed).toHaveLength(2)
    expect(trading.state.closed[0].exitTime).toBe(source[17].timestamp)
    expect(trading.state.closed[0].totalCommissionUsd).toBeGreaterThan(0)
    await act(async () => replay.navigate('forward', 'H1'))
    const state = trading.state, equity = trading.equity, executionCursor = trading.executionCursor, timestamp = replay.timestamp
    await act(async () => replay.navigate('backward', 'H1'))
    expect(replay.reviewing).toBe(true); expect(replay.displayCount).toBe(60)
    expect(trading.permission.active).toBe(false); expect(replay.canPlay).toBe(false); expect(replay.canNext).toBe(false)
    expect(trading.state).toBe(state); expect(trading.equity).toBe(equity); expect(trading.executionCursor).toBe(executionCursor); expect(replay.timestamp).toBe(timestamp)
    await act(async () => replay.navigate('forward', 'H1'))
    expect(replay.reviewing).toBe(false); expect(trading.permission.active).toBe(true)
    await act(async () => replay.navigate('backward', 'H1'))
    await act(async () => replay.returnToCurrent())
    expect(replay.displayCount).toBe(executionCursor); expect(trading.state).toBe(state)
    await act(async () => { replay.navigate('forward', 'M5'); replay.navigate('forward', 'M5') })
    expect(replay.count).toBe(125) // Duplicate advances in the same render are ignored.
    await act(async () => replay.play())
    const playingCount = replay.count
    await act(async () => replay.navigate('forward', 'H1'))
    expect(replay.count).toBe(playingCount)
    await act(async () => replay.pause())
    await act(async () => replay.navigate('backward', 'H1'))
    await act(async () => replay.restart())
    expect(replay.reviewing).toBe(false)
  } finally { await act(async () => root.unmount()) }
})
it('blocks a timeframe step before rollover without executing the next contract', async () => {
  const history = fixtureHistory('2024-01-08', '2024-01-12', '2024-01-10')
  let replay!: ReturnType<typeof useReplay>, trading!: ReturnType<typeof useTrading>
  const root = createRoot(document.createElement('div'))
  function Harness() { replay = useReplay(history.candles); trading = useTrading(history, replay); return null }
  try {
    await act(async () => root.render(<Harness />)); await act(async () => replay.start())
    await act(async () => trading.enterAutomatic('buy', { mode: 'risk', riskPercent: 1 }, 1.09))
    await act(async () => replay.navigate('forward', 'D1'))
    expect(replay.blocked).toBe(true); expect(replay.playing).toBe(false)
    expect(trading.state.observedTimestamp).toBeLessThan(Date.parse('2024-01-10'))
    expect(trading.state.positions).toHaveLength(1)
    const state = trading.state
    await act(async () => replay.navigate('forward', 'D1'))
    expect(trading.state).toBe(state)
  } finally { await act(async () => root.unmount()) }
})
