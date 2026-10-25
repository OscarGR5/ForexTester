import { expect, it } from 'vitest'
import { cancelEntry, combinedOpenPnl, createTradingState, observeCandle, requestAutomaticEntry, requestClose, type Quote } from './trading'

const permission = { active: true, playing: false, hasFuture: true }
const bar = (minute: number, price = 1.1) => ({ timestamp: minute * 60_000, open: price, high: price + .0001, low: price - .0001, close: price })
function initial() {
  return observeCandle(createTradingState(0, { referenceBalance: 80_000, maxRiskPercent: 10 }, { roundTripUsdPerLot: 7 }), bar(1), undefined, 'single')
}
function open(lots = 1) {
  return observeCandle(requestAutomaticEntry(initial(), 'buy', lots, 1.09, permission), bar(2), undefined, 'single')
}
it('returns no total without open positions, including pending-only states', () => {
  expect(combinedOpenPnl(initial())).toBeNull()
  expect(combinedOpenPnl(requestAutomaticEntry(initial(), 'buy', 1, 1.09, permission))).toBeNull()
})
it.each([1.102, 1.098, 1.10007])('values a single position at %s, including entry and estimated exit commissions', price => {
  const state = { ...open(), quote: { priceModel: 'single', trade: bar(3, price) } as const }
  const net = (price - 1.1) * 100_000 - 7
  expect(combinedOpenPnl(state)?.estimatedNetPnlUsd).toBeCloseTo(net, 9)
  expect(combinedOpenPnl(state)?.percent).toBeCloseTo(net / 80_000 * 100, 12)
})
it('sums two entries with different sizes and opposite outcomes using the account reference balance', () => {
  const state = open()
  state.positions = [
    { ...state.positions[0], entryPrice: 1.099, referenceBalance: 100_000 },
    { ...state.positions[0], id: 'second', lots: 2, entryPrice: 1.101, entryCommissionUsd: 7, referenceBalance: 200_000 },
  ]
  const total = combinedOpenPnl(state)!
  expect(total.estimatedNetPnlUsd).toBeCloseTo(100 - 7 - 200 - 14, 8)
  expect(total.percent).toBeCloseTo(-121 / 80_000 * 100, 10)
})
it('preserves fractional cents until formatting and supports exact zero', () => {
  const state = open()
  // Flat prices isolate commission precision from binary price subtraction.
  state.positions = [0, 1].map(i => ({ ...state.positions[0], id: String(i), entryCommissionUsd: .004, commission: { roundTripUsdPerLot: 0 } }))
  expect(combinedOpenPnl(state)!.estimatedNetPnlUsd).toBe(-.008)
  state.positions = state.positions.map(p => ({ ...p, entryCommissionUsd: 0 }))
  expect(combinedOpenPnl(state)).toEqual({ estimatedNetPnlUsd: 0, percent: 0 })
})
it.each<Quote | null>([null, { bid: bar(3), ask: null }, { bid: null, ask: bar(3) }, { priceModel: 'single', trade: null }, { priceModel: 'single', trade: bar(3, NaN) }])('reports unavailable for missing or invalid quotes: %j', quote => {
  expect(combinedOpenPnl({ ...open(), quote })).toBeNull()
})
it('does not silently omit an unvalueable position', () => {
  const state = open()
  state.positions.push({ ...state.positions[0], id: 'invalid', entryPrice: NaN })
  expect(combinedOpenPnl(state)).toBeNull()
})
it('updates after a quote change and completed close; excludes pending, closed, cancelled and rejected entries', () => {
  let state = open()
  const first = state.positions[0]
  state = requestAutomaticEntry(state, 'buy', 2, 1.09, permission)
  // Pending entries do not affect the open total.
  expect(combinedOpenPnl(state)!.estimatedNetPnlUsd).toBe(-7)
  state = observeCandle(state, bar(3, 1.101), undefined, 'single')
  expect(combinedOpenPnl(state)!.estimatedNetPnlUsd).toBeCloseTo(100 - 21, 8)
  state = requestClose(state, first.id, permission)
  expect(combinedOpenPnl(state)!.estimatedNetPnlUsd).toBeCloseTo(79, 8)
  state = observeCandle(state, bar(4, 1.102), undefined, 'single')
  expect(state.closed).toHaveLength(1)
  expect(combinedOpenPnl(state)!.estimatedNetPnlUsd).toBeCloseTo(200 - 14, 8)
  state = observeCandle(requestClose(state, state.positions[0].id, permission), bar(5), undefined, 'single')
  state = requestAutomaticEntry(state, 'sell', 1, 1.11, permission)
  state = cancelEntry(state, state.pending[0].id)
  state = requestAutomaticEntry(state, 'buy', 1, 1.09, permission)
  state = observeCandle(state, bar(6, 1.08), undefined, 'single')
  expect(state.cancelled).toHaveLength(1)
  expect(state.rejected).toHaveLength(1)
  expect(combinedOpenPnl(state)).toBeNull()
})
it.each([0, -1, NaN, Infinity])('reports unavailable for an invalid reference balance %s', referenceBalance => {
  const state = open()
  expect(combinedOpenPnl({ ...state, account: { ...state.account, referenceBalance } })).toBeNull()
})
