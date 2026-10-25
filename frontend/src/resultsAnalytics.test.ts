import { describe, expect, it } from 'vitest'
import { completedSetups, equityPerformance, monthlyPerformance, returnPercent, setupPerformance, startingDeficit } from './resultsAnalytics'
import { journalSetups, type Observation } from './analytics'
import { createEquityLedger, recordEquity } from './equity'
import { downsampleEquity, equityObservations } from './equityDisplay'
import { createTradingState, modifyStop, observeCandle, requestClose, requestEntry } from './trading'
import { nearestObservation, timelinePath } from './ResultsCharts'
import { decimal, duration, percent, rValue, usd } from './resultsFormatting'

const permission = { active: true, playing: false, hasFuture: true }, base = Date.UTC(2024, 0, 31, 23, 55)
const candle = (i: number, open = 1.1, close = open) => ({ timestamp: base + i * 60000, open, close, low: Math.min(open, close) - .00001, high: Math.max(open, close) + .00001 })
function simulation(balance = 100_000) {
  let state = createTradingState(1, { referenceBalance: balance, maxRiskPercent: 100 }, { roundTripUsdPerLot: 7 }), ledger = createEquityLedger(balance)
  const tick = (i: number, price = 1.1, missing = false) => { const previous = state; state = observeCandle(state, candle(i, price), missing ? undefined : candle(i, price + .0002)); ledger = recordEquity(ledger, previous, state) }
  tick(0)
  return { get state() { return state }, get ledger() { return ledger }, tick, change: (fn: (s: typeof state) => typeof state) => { state = fn(state) } }
}
const obs = (net: number, risk = 100, i = 0, exitTime = base + i * 60000): Observation => ({ id: String(i), netPnlUsd: net, initialRiskUsd: risk, grossPnlUsd: net + 7, totalCommissionUsd: 7, entryTime: exitTime - 120000, exitTime })

describe('completed setup accounting for Results', () => {
  it('combines unequal rounded-down executed risks, mixed positions and commissions without normalizing to 2%', () => {
    const s = simulation(); s.change(state => requestEntry(state, 'buy', { mode: 'risk', riskPercent: 1 }, 1.0967, permission))
    const setup = s.state.pending[0].setupId
    s.change(state => requestEntry(state, 'buy', { mode: 'risk', riskPercent: 1 }, 1.0951, permission, setup)); s.tick(1)
    const originalRisk = s.state.positions.reduce((sum, p) => sum + p.initialRiskUsd, 0)
    expect(originalRisk).toBeLessThan(2000); expect(originalRisk).toBeGreaterThan(1980)
    expect(s.state.positions[0].initialRiskUsd).not.toBe(s.state.positions[1].initialRiskUsd)
    s.change(state => modifyStop(state, state.positions[0].id, 1.098, permission))
    s.change(state => requestClose(state, state.positions[0].id, permission)); s.tick(2, 1.103)
    expect(completedSetups(s.state)).toEqual([]); expect(journalSetups(s.state)[0].netR).toBeNull()
    s.change(state => requestClose(state, state.positions[0].id, permission)); s.tick(8, 1.099)
    const combined = completedSetups(s.state), stats = setupPerformance(combined, 100_000)
    expect(combined).toHaveLength(1); expect(s.state.closed[0].netPnlUsd).toBeGreaterThan(0); expect(s.state.closed[1].netPnlUsd).toBeLessThan(0)
    expect(combined[0].initialRiskUsd).toBe(originalRisk)
    expect(stats.totalNetR).toBeCloseTo(s.state.closed.reduce((sum, p) => sum + p.netPnlUsd, 0) / originalRisk)
    expect(stats.totalCommissionUsd).toBeCloseTo(s.state.closed.reduce((sum, p) => sum + p.totalCommissionUsd, 0))
    expect(stats.averageHoldingMs).toBe(7 * 60000)
    expect(monthlyPerformance(combined, 100_000, base, base + 8 * 60000).map(m => m.count)).toEqual([0, 1])
  })
  it('uses one position as one setup and preserves a zero-risk denominator as unavailable', () => {
    const s = simulation(); s.change(state => requestEntry(state, 'buy', 1, 1.09, permission)); s.tick(1)
    s.change(state => requestClose(state, state.positions[0].id, permission)); s.tick(2, 1.102)
    expect(completedSetups(s.state)).toHaveLength(1)
    const [o] = completedSetups(s.state)
    expect(setupPerformance([o], 100_000).totalNetR).toBe(o.netPnlUsd / o.initialRiskUsd)
    expect(setupPerformance([o, obs(10, 0)], 100_000)).toMatchObject({ totalNetR: null, averageNetR: null, averageWinnerR: null })
  })
  it('reports the approved two-position $2,200 / $2,000 example as one +1.10R setup', () => {
    const s = simulation(); s.change(state => requestEntry(state, 'buy', 1, 1.09, permission)); s.tick(1)
    s.change(state => requestClose(state, state.positions[0].id, permission)); s.tick(2)
    const template = s.state.closed[0]
    const state = { ...s.state, closed: [1500, 700].map((netPnlUsd, index) => ({ ...template, id: `example-${index}`, initialRiskUsd: 1000, netPnlUsd })) }
    expect(setupPerformance(completedSetups(state), 100_000)).toMatchObject({ count: 1, totalNetR: 1.1, averageNetR: 1.1 })
  })
  it('orders simultaneous completions by setup ID deterministically', () => {
    const s = simulation(); s.change(state => requestEntry(state, 'buy', 1, 1.09, permission)); s.tick(1)
    s.change(state => requestClose(state, state.positions[0].id, permission)); s.tick(2)
    const p = s.state.closed[0], a = { ...s.state.setups[0], id: 'a' }, b = { ...s.state.setups[0], id: 'b' }
    const state = { ...s.state, setups: [b, a], closed: [{ ...p, id: '2', setupId: 'b' }, { ...p, id: '1', setupId: 'a' }] }
    expect(completedSetups(state).map(o => o.id)).toEqual(['a', 'b'])
    expect(completedSetups({ ...state, closed: [...state.closed].reverse() })).toEqual(completedSetups(state))
  })
  it('uses net outcomes for PF, breakevens, R averages, extrema and losing streak interruption', () => {
    const stats = setupPerformance([200, -100, -50, 0, -300, 400, -40, -20, -10].map((n, i) => obs(n, i === 0 ? 200 : 100, i)), 10_000)
    expect(stats).toMatchObject({ winningCount: 2, losingCount: 6, zeroCount: 1, maxLosingStreak: 3, averageWinnerR: 2.5, largestWinnerR: 4, largestLoserR: -3 })
    expect(stats.averageLoserR).toBeCloseTo(-5.2 / 6); expect(stats.winRatePercent).toBeCloseTo(2 / 9 * 100)
    expect(stats.profitFactor).toBeCloseTo(600 / 520)
    expect(setupPerformance([-1, -1, 0, -1, -1].map(n => obs(n)), 100).maxLosingStreak).toBe(2)
    expect(setupPerformance([obs(-.01)], 100).averageWinnerR).toBeNull()
  })
  it.each([{ nets: [], pf: null, win: null }, { nets: [1, 2], pf: Infinity, win: 100 }, { nets: [-1], pf: 0, win: 0 }, { nets: [0], pf: null, win: 0 }, { nets: [1, -1, 0], pf: 1, win: 100 / 3 }])('handles PF and win-rate edges $nets', ({ nets, pf, win }) => {
    const stats = setupPerformance(nets.map(n => obs(n)), 100)
    expect(stats.profitFactor).toBe(pf); win === null ? expect(stats.winRatePercent).toBeNull() : expect(stats.winRatePercent).toBeCloseTo(win)
    if (!nets.length) expect(stats).toMatchObject({ totalNetR: null, averageWinnerR: null, averageLoserR: null, maxLosingStreak: null, averageHoldingMs: null })
  })
})

describe('UTC monthly realized contribution', () => {
  it('includes empty months only within replay, across years, and attributes cross-month setups once at final exit', () => {
    const start = Date.UTC(2023, 11, 31, 23, 59), endpoint = Date.UTC(2024, 2, 1)
    const values = [obs(100, 100, 0, start), { ...obs(-50, 100, 1, Date.UTC(2024, 0, 1)), entryTime: start }, obs(500, 100, 2, endpoint + 60000)]
    const result = monthlyPerformance(values, 10_000, start, endpoint)
    expect(result.map(m => m.month)).toEqual(['2023-12', '2024-01', '2024-02', '2024-03'])
    expect(result.map(m => [m.count, m.netReturnPercent, m.profitFactor])).toEqual([[1, 1, Infinity], [1, -.5, 0], [0, 0, null], [0, 0, null]])
    expect(monthlyPerformance([], 100, start, null)).toEqual([])
    expect(monthlyPerformance([], 100, start, start - 1)).toEqual([])
  })
})

describe('ledger-based return and drawdowns', () => {
  it('includes entry fees and unrealized PnL at finish with open positions and intratrade drawdown', () => {
    const s = simulation(10_000); s.change(state => requestEntry(state, 'buy', 1, 1.08, permission)); s.tick(1)
    expect(equityPerformance(s.ledger, 10_000).netReturnUsd).toBeCloseTo(-23.5)
    expect(completedSetups(s.state)).toEqual([])
    s.tick(2, 1.09); s.tick(3, 1.11); s.tick(4, 1.105)
    const result = equityPerformance(s.ledger, 10_000)
    expect(result.maxStartingDeficitUsd).toBeCloseTo(1023.5)
    expect(result.maxStartingDeficitPercent).toBeCloseTo(10.235)
    expect(result.maxPeakDrawdownPercent).toBeCloseTo(10.235)
    expect(result.netReturnPercent).toBeCloseTo(4.765)
    expect(s.state.positions).toHaveLength(1); expect(s.state.closed).toHaveLength(0)
  })
  it('distinguishes peak loss above initial capital and percentage maximum context from dollar maximum', () => {
    const s = simulation(10_000); s.change(state => requestEntry(state, 'buy', 1, 1.08, permission)); s.tick(1, 1.1)
    s.tick(2, 1.13); s.tick(3, 1.12)
    const r = equityPerformance(s.ledger, 10_000)
    expect(r.maxStartingDeficitUsd).toBeCloseTo(23.5)
    expect(r.maxPeakDrawdownPercent).toBeCloseTo(1000 / 12976.5 * 100)
    expect(r.peakPoint?.timestamp).toBe(base + 3 * 60000)
    s.tick(4, 1.2); s.tick(5, 1.186)
    const later = equityPerformance(s.ledger, 10_000)
    expect(s.ledger.maxDrawdownUsd).toBeCloseTo(1400)
    expect(later.maxPeakDrawdownPercent).toBe(r.maxPeakDrawdownPercent)
    expect(later.peakPoint?.timestamp).toBe(base + 3 * 60000)
    expect(later.peakPoint?.drawdownUsd).toBeCloseTo(1000)
    const above = simulation(); above.tick(1)
    expect(equityPerformance(above.ledger, 100_000).maxStartingDeficitPercent).toBe(0)
    expect(startingDeficit({ ...s.ledger.tail!.point, equityUsd: 11000 }, 10000)).toBe(0)
  })
  it('preserves full-resolution extrema before display downsampling and missing/weekend gaps', () => {
    const s = simulation(10_000); s.change(state => requestEntry(state, 'sell', 1, 1.19, permission)); s.tick(1)
    for (let i = 2; i < 5000; i++) s.tick(i < 3000 ? i : i + 2880, i === 2711 ? 1.15 : 1.1, i === 2000)
    const all = equityObservations(s.ledger), sample = downsampleEquity(all, 100), expected = equityPerformance(s.ledger, 10_000)
    expect(sample.length).toBeLessThan(all.length / 5); expect(expected.maxStartingDeficitUsd).toBeCloseTo(5023.5)
    expect(sample).toContain(all[2711]); expect(sample).toContain(all[2000]); expect(sample).toContain(all[3000])
    const path = timelinePath(sample, p => p.equityUsd, n => n, n => n)
    expect((path.solid.match(/M/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect((path.bridges.match(/L/g) ?? []).length).toBe(2)
    expect(nearestObservation(sample, (all[2999].timestamp + all[3000].timestamp) / 2)).toBeNull()
    expect(nearestObservation(sample, all[2000].timestamp)?.equityUsd).toBeNull()
    s.tick(8000, 1.1, true); expect(equityPerformance(s.ledger, 10_000).netReturnPercent).toBeNull()
    expect(equityPerformance(s.ledger, 10_000).maxStartingDeficitUsd).toBe(expected.maxStartingDeficitUsd)
  })
  it('keeps peak percentage unavailable after nonpositive equity, and missing/empty values honest', () => {
    const s = simulation(10_000); s.change(state => requestEntry(state, 'sell', 1, 1.19, permission)); s.tick(1); s.tick(2, 1.25)
    expect(equityPerformance(s.ledger, 10_000).maxPeakDrawdownPercent).toBeNull()
    expect(equityPerformance(s.ledger, 10_000).maxStartingDeficitPercent).toBeGreaterThan(100)
    expect(equityPerformance(createEquityLedger(10_000), 10_000)).toMatchObject({ maxStartingDeficitPercent: null, maxPeakDrawdownPercent: null, netReturnPercent: null })
    for (const bad of [0, -1, Infinity, NaN]) expect(returnPercent(100, bad)).toBeNull()
  })
})

it('formats financial units, signs and unavailable values without misleading rounded negative zero', () => {
  expect(usd(-.00001)).toBe('$0.00'); expect(percent(-.00001)).toBe('0.00%'); expect(rValue(1.1)).toBe('+1.10R')
  expect(usd(2200, true)).toBe('+$2,200.00'); expect(duration(3600000)).toBe('1.0 h')
  for (const value of [null, undefined, NaN, Infinity]) { expect(decimal(value)).toBe('N/A'); expect(usd(value)).toBe('N/A'); expect(percent(value)).toBe('N/A'); expect(rValue(value)).toBe('N/A') }
})
