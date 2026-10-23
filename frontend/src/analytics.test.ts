import { describe, expect, it } from 'vitest'
import { completedObservations, journalSetups, netR, performanceStats, realizedPerformance, type Observation } from './analytics'
import { cancelEntry, createTradingState, modifyStop, observeCandle, requestClose, requestEntry, type ClosedTrade } from './trading'

const permission = { active: true, playing: false, hasFuture: true }
const base = Date.UTC(2024, 0, 9)
const candle = (minute: number, price = 1.1) => ({ timestamp: base + minute * 60_000, open: price, high: price + 0.0001, low: price - 0.0001, close: price })
function initial() { return observeCandle(createTradingState(0, { referenceBalance: 100_000, maxRiskPercent: 100 }, { roundTripUsdPerLot: 35 }), candle(0), candle(0, 1.1002)) }
function template() {
  let state = requestEntry(initial(), 'buy', 1, 1.09, permission)
  state = observeCandle(state, candle(1), candle(1, 1.1002))
  state = requestClose(state, state.positions[0].id, permission)
  return observeCandle(state, candle(2), candle(2, 1.1002)).closed[0]
}
function observation(net: number, risk = 1000, index = 0): Observation {
  return { id: String(index), initialRiskUsd: risk, netPnlUsd: net, grossPnlUsd: net + 35, totalCommissionUsd: 35,
    entryTime: base, exitTime: base + (index + 1) * 60_000 }
}
function closed(net: number, index = 0, risk = 1000): ClosedTrade {
  return { ...template(), ...observation(net, risk, index), setupId: '0-S1' }
}

describe('net performance analytics', () => {
  it('keeps net-zero results in the win-rate denominator and averages strictly negative losers', () => {
    const values = [100, 200, 300, 400, -100, -200, -200, 0].map((net, index) => observation(net, 1000, index))
    const stats = performanceStats(values, 10_000)
    expect(stats).toMatchObject({ count: 8, winningCount: 4, losingCount: 3, zeroCount: 1, nonWinningCount: 4,
      winRatePercent: 50, netPnlUsd: 500, grossPnlUsd: 780, totalCommissionUsd: 280, profitFactor: 2,
      averageWinnerUsd: 250, largestWinnerUsd: 400, largestLoserUsd: -200, netReturnPercent: 5 })
    expect(stats.averageLoserUsd).toBeCloseTo(-500 / 3)
    expect(stats.totalNetR).toBeCloseTo(0.5)
    expect(stats.averageNetR).toBeCloseTo(0.0625)
    expect(stats.averageHoldingMs).toBe(270_000)
  })

  it('classifies positive gross PnL with a negative net result as a loss', () => {
    const result = observation(-15)
    expect(result.grossPnlUsd).toBe(20)
    expect(performanceStats([result], 10_000)).toMatchObject({ winningCount: 0, losingCount: 1, winRatePercent: 0, profitFactor: 0 })
  })

  it.each([
    { values: [], pf: null, wr: null }, { values: [10, 20], pf: Infinity, wr: 100 },
    { values: [-10, -20], pf: 0, wr: 0 }, { values: [0, 0], pf: null, wr: 0 },
    { values: [10, 0], pf: Infinity, wr: 50 }, { values: [10, -5, 0], pf: 2, wr: 100 / 3 },
  ])('handles profit factor and empty outcomes: $values', ({ values, pf, wr }) => {
    const result = performanceStats(values.map((net) => observation(net)), 10_000)
    expect(result.profitFactor).toBe(pf)
    wr === null ? expect(result.winRatePercent).toBeNull() : expect(result.winRatePercent).toBeCloseTo(wr)
    for (const value of Object.values(result)) if (typeof value === 'number') expect(Number.isNaN(value)).toBe(false)
  })

  it('calculates net R with the original gross risk and omits invalid denominators', () => {
    expect(netR(1965, 1000)).toBe(1.965)
    expect(netR(-1500, 1000)).toBe(-1.5)
    for (const invalid of [0, -1, NaN, Infinity]) expect(netR(100, invalid)).toBeNull()
    expect(netR(Infinity, 100)).toBeNull()
    const result = performanceStats([observation(100, 0), observation(200, 100)], 1000)
    expect(result).toMatchObject({ validRCount: 1, totalNetR: 2, averageNetR: 2 })
  })

  it('counts a fully closed two-position setup once and weights R by original risk', () => {
    const state = { ...initial(), setups: [{ id: '0-S1', symbol: 'EURUSD' as const, direction: 'buy' as const, title: '', tag: '', notes: '' }],
      closed: [closed(1000, 0, 1000), closed(-250, 1, 500)] }
    const [row] = journalSetups(state)
    expect(row).toMatchObject({ status: 'completed', initialRiskUsd: 1500, netPnlUsd: 750, grossPnlUsd: 820, totalCommissionUsd: 70, netR: 0.5,
      entryTime: base, exitTime: base + 120_000 })
    expect(performanceStats(completedObservations([row]), 100_000)).toMatchObject({ count: 1, netPnlUsd: 750, averageNetR: 0.5 })
    expect(performanceStats(state.closed, 100_000)).toMatchObject({ count: 2, averageNetR: 0.25 })
  })

  it('excludes partially closed, pending-only and rejected/cancelled setups from completed KPIs', () => {
    let state = requestEntry(initial(), 'buy', 0.01, 1.09, permission)
    const setupId = state.pending[0].setupId
    state = requestEntry(state, 'buy', 0.02, 1.095, permission, setupId)
    expect(completedObservations(journalSetups(state))).toEqual([])
    state = observeCandle(state, candle(1), candle(1, 1.1002))
    state = requestClose(state, state.positions[0].id, permission)
    state = observeCandle(state, candle(2), candle(2, 1.1002))
    const [row] = journalSetups(state)
    expect(row.status).toBe('partially closed')
    expect(row.netR).toBeNull()
    expect(row.exitTime).toBeNull()
    expect(completedObservations([row])).toEqual([])
    expect(performanceStats(state.closed, 100_000).count).toBe(1)
    state = requestEntry(state, 'buy', 0.01, 1.101, permission)
    state = observeCandle(state, candle(3), candle(3, 1.1002))
    state = requestEntry(state, 'buy', 0.01, 1.09, permission)
    state = cancelEntry(state, state.pending[0].id)
    expect(journalSetups(state).slice(1).map((item) => item.status)).toEqual(['rejected/cancelled', 'rejected/cancelled'])
    expect(completedObservations(journalSetups(state))).toEqual([])
  })

  it('keeps original risk after SL movement and captures a gap-through stop worse than -1R', () => {
    let state = requestEntry(initial(), 'buy', 1, 1.09, permission)
    state = observeCandle(state, candle(1), candle(1, 1.1002))
    const risk = state.positions[0].initialRiskUsd
    state = modifyStop(state, state.positions[0].id, 1.095, permission)
    state = observeCandle(state, candle(2, 1.08), candle(2, 1.0802))
    expect(state.closed[0].stopFillType).toBe('gap_open')
    expect(state.closed[0].initialRiskUsd).toBe(risk)
    // 1.1002 to 1.0800 at one lot = -$2,020 gross; -$2,055 net / $1,020 original risk.
    expect(netR(state.closed[0].netPnlUsd, risk)).toBeCloseTo(-2055 / 1020)
    expect(journalSetups(state)[0].netR).toBeCloseTo(-2055 / 1020)
  })
})

describe('chronological closed-position drawdown', () => {
  it('starts at the reference balance and handles early losses and a higher balance peak', () => {
    const result = realizedPerformance([closed(-1000, 0), closed(2000, 1), closed(-2200, 2)], 10_000)
    expect(result.points.map((point) => point.cumulativeNetPnlUsd)).toEqual([0, -1000, 1000, -1200])
    expect(result.points.map((point) => point.highWaterMarkUsd)).toEqual([10_000, 10_000, 11_000, 11_000])
    expect(result.points.map((point) => point.drawdownUsd)).toEqual([0, 1000, 0, 2200])
    expect(result).toMatchObject({ maxDrawdownUsd: 2200, maxDrawdownPercent: 20, nonpositiveBalance: false })
  })

  it('preserves execution order for identical timestamps and does not mutate source events', () => {
    const wins = closed(100, 0), loss = closed(-200, 1)
    loss.exitTime = wins.exitTime
    const input = [loss, wins]
    const result = realizedPerformance(input, 1000)
    expect(result.points.map((point) => point.positionId)).toEqual([null, '1', '0'])
    expect(result.points.map((point) => point.cumulativeNetPnlUsd)).toEqual([0, -200, -100])
    expect(result.maxDrawdownUsd).toBe(200)
    expect(realizedPerformance([wins, loss], 1000).maxDrawdownUsd).toBe(200)
    expect(result.maxDrawdownPercent).toBe(20)
    expect(realizedPerformance([wins, loss], 1000).maxDrawdownPercent).toBeCloseTo(200 / 1100 * 100)
    expect(input).toEqual([loss, wins])
  })

  it('sorts distinct exits chronologically and reflects only the supplied revealed events', () => {
    const first = closed(-100, 0), second = closed(300, 1)
    expect(realizedPerformance([second, first], 1000).points.map((point) => point.cumulativeNetPnlUsd)).toEqual([0, -100, 200])
    expect(realizedPerformance([first], 1000).points).toHaveLength(2)
    expect(realizedPerformance([], 1000)).toMatchObject({ maxDrawdownUsd: 0, maxDrawdownPercent: 0 })
  })

  it.each([-1000, -1500])('reports unavailable percentage after zero/negative balance: %s', (loss) => {
    const result = realizedPerformance([closed(loss)], 1000)
    expect(result.maxDrawdownUsd).toBe(-loss)
    expect(result.maxDrawdownPercent).toBeNull()
    expect(result.points[1].drawdownPercent).toBeNull()
    expect(result.nonpositiveBalance).toBe(true)
  })
})
