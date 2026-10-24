import { expect, it } from 'vitest'
import { fixtureHistory } from '../../tests/databentoFixture'
import { aggregateBidCandles, historyCandles, parseHistory, rolloverIndex, TIMEFRAMES } from './history'
import { createTradingState, observeCandle, requestEntry, requestClose, markPosition } from './trading'
import { createEquityLedger, recordEquity } from './equity'
import { historyFingerprint } from './sessionCodec'
import { ReplayBars } from './replayBars'
const permission = { active: true, playing: false, hasFuture: true }
const base = Date.parse('2024-01-09')
const bar = (offset: number, open = 1.1, low = 1.0995, high = 1.1005, instrumentId = 101) => ({ timestamp: base + offset * 60000, open, high, low, close: open, volume: '10', instrumentId })
const observe = (state: ReturnType<typeof createTradingState>, candle: ReturnType<typeof bar>) => observeCandle(state, candle, undefined, 'single')
const started = () => observe({ ...createTradingState(), symbol: '6E' }, bar(0))
it.each(['buy', 'sell'] as const)('%s entry uses the next trade open without bid/ask copies and stops on its same eligible M1', direction => {
  let state = requestEntry(started(), direction, .01, direction === 'buy' ? 1.099 : 1.101, permission)
  state = observe(state, bar(1, 1.1001, 1.098, 1.102))
  expect(state.quote).toEqual({ priceModel: 'single', trade: bar(1, 1.1001, 1.098, 1.102) })
  expect(state.closed).toHaveLength(1); expect(state.closed[0]).toMatchObject({ entryPrice: 1.1001, exitReason: 'stop_loss', stopFillType: 'level' })
  expect(state.setups[0].symbol).toBe('6E')
})
it.each(['buy', 'sell'] as const)('%s missing candles and gap-open stops use the next observed open', direction => {
  let state = requestEntry(started(), direction, .01, direction === 'buy' ? 1.099 : 1.101, permission)
  state = observe(state, bar(1))
  state = observe(state, direction === 'buy' ? bar(10, 1.098, 1.097, 1.099) : bar(10, 1.102, 1.101, 1.103))
  expect(state.closed[0]).toMatchObject({ stopFillType: 'gap_open', exitPrice: direction === 'buy' ? 1.098 : 1.102 })
  expect(state.closed[0].coverageWarnings[0]).toMatchObject({ side: 'trade', reason: 'clock_gap', from: base + 2 * 60000, to: base + 9 * 60000 })
})
it('manual close uses the next eligible opening before its intrabar stop, with two independent positions and configurable fees', () => {
  let state = { ...started(), commission: { roundTripUsdPerLot: 7 } }
  state = requestEntry(state, 'buy', .01, 1.099, permission)
  state = requestEntry(state, 'sell', .01, 1.101, permission)
  state = observe(state, bar(1))
  expect(state.positions).toHaveLength(2)
  expect(markPosition(state.positions[0], state.quote)?.price).toBe(1.1)
  state = requestClose(state, state.positions[0].id, permission)
  state = observe(state, bar(5, 1.1002, 1.098, 1.1005))
  expect(state.closed[0]).toMatchObject({ exitReason: 'manual', exitPrice: 1.1002, totalCommissionUsd: .07 })
  expect(state.positions).toHaveLength(1)
})
it('records single-price equity using the same trade close, never a fabricated spread', () => {
  let state = requestEntry(started(), 'sell', .01, 1.101, permission)
  const previous = state; state = observe(state, bar(1))
  const ledger = recordEquity(createEquityLedger(100000), previous, state)
  expect(ledger.tail?.point).toMatchObject({ unrealizedUsd: 0, missingSides: [] })
})
it('keeps contracts separate in all aggregates and fingerprints contract identity, volume, source and ranges', async () => {
  const history = { ...fixtureHistory('2023-12-10', '2024-01-11', '2024-01-09'), tradingFrom: '2024-01-09' }
  const changed = structuredClone(history); changed.contracts[0].instrumentId = 303; changed.candles[0].instrumentId = 303
  expect(await historyFingerprint(history)).not.toBe(await historyFingerprint(changed))
  const bars = [bar(0, 1.1, 1.099, 1.101), bar(1, 1.2, 1.199, 1.201, 202), bar(2, 1.2, 1.198, 1.202, 202)]
  expect(rolloverIndex(bars, 0)).toBe(1)
  for (const tf of TIMEFRAMES.filter(tf => tf !== 'M1')) {
    const aggregated = aggregateBidCandles(bars, tf)
    expect(aggregated).toHaveLength(2); expect(aggregated[0].high).toBe(1.101); expect(aggregated[1].low).toBe(1.198)
    const replay = new ReplayBars(tf); replay.advance(bars, bars.length)
    expect(replay.candles).toHaveLength(2); expect(replay.candles[0].high).toBe(1.101)
  }
  expect(historyCandles(parseHistory(history, history))).toEqual(history.candles)
})

it('blocks engine transitions across contracts before entries, manual closes or stops can execute', () => {
  let state = requestEntry(started(), 'buy', .01, 1.099, permission)
  state = observe(state, bar(1))
  state = requestClose(state, state.positions[0].id, permission)
  const original = structuredClone(state)
  expect(() => observe(state, bar(2, 1.01, 1, 1.02, 202))).toThrow('contract rollover')
  expect(state).toEqual(original)
})
