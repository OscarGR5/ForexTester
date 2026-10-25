import { expect, it } from 'vitest'
import { createEquityLedger, type EquityPoint } from './equity'
import { downsampleEquity, equityObservations, equityWindow, equityWindowStart, flatEquityGaps } from './equityDisplay'
import { nearestObservation, timelinePath } from './ResultsCharts'
import { equityPerformance } from './resultsAnalytics'
import { resultsFixture } from '../../tests/resultsFixture'

const day = 86_400_000, start = Date.UTC(2024, 0, 1)
const point = (timestamp: number, overrides: Partial<EquityPoint> = {}): EquityPoint => ({
  timestamp, cashUsd: 10000, equityUsd: 10000, unrealizedUsd: 0, drawdownUsd: 0, drawdownPercent: 0,
  missingSides: [], clockGap: false, ...overrides,
})

it('keeps the UTC window boundary when a holiday has no observation at midnight, without adding an observation', () => {
  const observations = [point(start), point(start + 3 * day + 60000, { clockGap: true })]
  const positions = [{ entryTime: start + 3 * day + 60000 }]
  expect(equityWindowStart(observations, positions)).toBe(start + 2 * day)
  expect(equityWindow(observations, positions)).toEqual([observations[1]])
  expect(nearestObservation(equityWindow(observations, positions), start + 2 * day)).toBeNull()
  expect(equityWindowStart(observations, [{ entryTime: start }])).toBe(start)
  expect(equityWindowStart(observations, [])).toBe(start)
})
const points = Array.from({ length: 10 }, (_, i) => point(start + i * day + 180_000))

it.each([
  { name: 'several days after replay start', positions: [{ entryTime: start + 5 * day + 1000 }], first: 4 },
  { name: 'first replay day', positions: [{ entryTime: start + 500_000 }], first: 0 },
  { name: 'no executed positions', positions: [], first: 0 },
  { name: 'open positions only', positions: [{ entryTime: start + 3 * day }], first: 2 },
  { name: 'unordered open and closed positions', positions: [{ entryTime: start + 7 * day }, { entryTime: start + 3 * day, exitTime: start + 4 * day }, { entryTime: start + 5 * day }], first: 2 },
])('windows from the preceding UTC date: $name', ({ positions, first }) => {
  const visible = equityWindow(points, positions)
  expect(visible[0]).toBe(points[first]) // first REAL observation, including its 00:03 timestamp
  expect(visible.at(-1)).toBe(points.at(-1))
  expect(visible).toEqual(points.slice(first))
})

it('retains full-resolution KPIs, extrema, quality counts and the immutable ledger after display filtering', () => {
  const { snapshot } = resultsFixture('populated', 8 * 1440)
  const original = snapshot.ledger, before = equityPerformance(original, 100000)
  const all = equityObservations(original), positions = [...snapshot.checkpoint.trading.positions, ...snapshot.checkpoint.trading.closed]
  const visible = equityWindow(all, positions), sampled = downsampleEquity(visible, 700)
  expect(visible.length).toBeLessThan(all.length)
  expect(sampled[0]).toBe(visible[0]); expect(sampled.at(-1)).toBe(all.at(-1))
  expect(equityPerformance(original, 100000)).toEqual(before)
  expect(snapshot.ledger).toBe(original); expect(original.count).toBe(all.length)
  expect(equityObservations(original)).toEqual(all)
})

it.each(['weekend', 'holiday'])('connects a confirmed constant no-position %s gap for all three series', () => {
  const observations = [point(start), point(start + 3 * day, { clockGap: true })]
  const gaps = flatEquityGaps(observations, [])
  for (const value of [(p: EquityPoint) => p.equityUsd, (p: EquityPoint) => p.drawdownPercent, (p: EquityPoint) => p.equityUsd! / 10000 - 1]) {
    expect(timelinePath(observations, value, t => (t - start) / day, v => v, gaps).solid).toContain('L3.00,')
  }
  expect(observations[1].clockGap).toBe(true)
  const hovered = nearestObservation(observations, start + day, gaps)
  expect(hovered).toBe(observations[0]); expect(hovered!.timestamp).toBe(start)
  expect(observations).toHaveLength(2)
})

it.each([
  { name: 'open exposure even at zero endpoint PnL', positions: [{ entryTime: start - day }], change: {} },
  { name: 'entry and exit entirely inside interval', positions: [{ entryTime: start + day, exitTime: start + 2 * day }], change: {} },
  { name: 'entry at right endpoint', positions: [{ entryTime: start + 3 * day }], change: {} },
  { name: 'same-minute entry and exit', positions: [{ entryTime: start + day, exitTime: start + day }], change: {} },
  { name: 'missing valuation', positions: [], change: { equityUsd: null, unrealizedUsd: null, missingSides: ['bid'] } },
  { name: 'invalid valuation', positions: [], change: { equityUsd: NaN } },
  { name: 'cash/commission changed', positions: [], change: { cashUsd: 9999 } },
  { name: 'equity changed', positions: [], change: { equityUsd: 9999 } },
] as const)('classifies unconfirmed clock gaps with $name', ({ positions, change }) => {
  const observations = [point(start), point(start + 3 * day, { ...change, missingSides: [...(change.missingSides ?? [])], clockGap: true })]
  const gaps = flatEquityGaps(observations, positions)
  expect(gaps.size).toBe(0)
  const path = timelinePath(observations, p => p.equityUsd, t => t, v => v, gaps)
  expect(path.solid).not.toContain('L')
  expect(path.bridges.includes('L')).toBe(!('equityUsd' in change) || (change.equityUsd !== null && Number.isFinite(change.equityUsd)))
  expect(nearestObservation(observations, start + day, gaps)).toBeNull()
})

it('requires both observations and the requested drawdown values to be valid', () => {
  const missing = [point(start, { equityUsd: null }), point(start + day, { clockGap: true })]
  expect(flatEquityGaps(missing, []).size).toBe(0)
  const observations = [point(start, { drawdownPercent: null }), point(start + day, { clockGap: true })]
  const gaps = flatEquityGaps(observations, [])
  expect(timelinePath(observations, p => p.drawdownPercent, t => t, v => v, gaps).bridges).toBe('')
})

it('allows previously closed positions and an exit accounted for at the left endpoint', () => {
  const observations = [point(start), point(start + 3 * day, { clockGap: true })]
  expect(flatEquityGaps(observations, [{ entryTime: start - day, exitTime: start }]).has(start + 3 * day)).toBe(true)
})

it('keeps real gap neighbors and extrema with bounded geometry for a 90-day M1 ledger', () => {
  let ledger = createEquityLedger(10000)
  for (let i = 0; i < 90 * 1440; i++) {
    const p = point(start + i * 60000 + (i >= 6000 ? 2 * day : 0), { clockGap: i === 6000 })
    ledger = { ...ledger, count: ledger.count + 1, tail: { point: p, previous: ledger.tail } }
  }
  const all = equityObservations(ledger), gaps = flatEquityGaps(all, []), sampled = downsampleEquity(all, 700)
  expect(sampled.length).toBeLessThan(2800)
  expect(sampled).toContain(all[5999]); expect(sampled).toContain(all[6000])
  const path = timelinePath(sampled, p => p.equityUsd, t => (t - start) / day, v => v, gaps)
  expect(path.solid.match(/M/g)).toHaveLength(1); expect(path.bridges).toBe(''); expect(path.solid).not.toMatch(/NaN|Infinity/)
  expect(ledger.count).toBe(129600)
})

it('connects every pair of valid fixture observations using only real endpoints for all four displays', async () => {
  const { resultsContinuityFixture } = await import('../../tests/resultsContinuityFixture')
  const { returnPercent, startingDeficit } = await import('./resultsAnalytics')
  const { ledger, points, positions } = resultsContinuityFixture()
  const before = JSON.stringify(ledger), kpis = equityPerformance(ledger, 10000)
  const window = equityWindow(points, positions), gaps = flatEquityGaps(window, positions)
  expect(equityWindowStart(points, positions)).toBe(Date.UTC(2024, 0, 4))
  for (const width of [1100, 1440]) {
    const sampled = downsampleEquity(window, width)
    for (const value of [
      (p: EquityPoint) => p.equityUsd,
      (p: EquityPoint) => returnPercent(p.equityUsd, 10000),
      (p: EquityPoint) => p.drawdownPercent === null ? null : -p.drawdownPercent,
      (p: EquityPoint) => { const d = startingDeficit(p, 10000); return d === null ? null : -d },
    ]) {
      const path = timelinePath(sampled, value, t => t, v => v, gaps)
      const valid = sampled.filter(p => p.equityUsd !== null && value(p) !== null)
      const edges = [...(path.solid + ' ' + path.bridges).matchAll(/L([\d.-]+),([\d.-]+)/g)]
      expect(edges).toHaveLength(valid.length - 1)
      expect(path.bridges.match(/M/g)).toHaveLength(4) // entry clock gap, exposed weekend, M1 hole, unavailable marks
      expect(path.solid).toContain('L' + points[13].timestamp.toFixed(2) + ',')
      for (const match of edges) {
        expect(valid.some(p => p.timestamp.toFixed(2) === match[1] && value(p)!.toFixed(2) === match[2])).toBe(true)
      }
      expect(path.bridges).not.toMatch(/NaN|Infinity/)
    }
  }
  expect(JSON.stringify(ledger)).toBe(before)
  expect(equityPerformance(ledger, 10000)).toEqual(kpis)
  expect(equityObservations(ledger)).toEqual(points)
  expect(points).toHaveLength(15)
})

it('does not bridge absent endpoints, and retains invalid and drawdown-only gaps during downsampling', () => {
  const observations = Array.from({ length: 10000 }, (_, i) => point(start + i * 60000))
  observations[4000] = point(start + 4000 * 60000, { equityUsd: NaN })
  observations[6000] = point(start + 6000 * 60000, { drawdownPercent: null })
  const sampled = downsampleEquity(observations, 10)
  for (const i of [3999, 4000, 4001, 5999, 6000, 6001]) expect(sampled).toContain(observations[i])
  expect(timelinePath(sampled, p => p.equityUsd, t => t, v => v).bridges.match(/M/g)).toHaveLength(1)
  expect(timelinePath(sampled, p => p.drawdownPercent, t => t, v => v).bridges.match(/M/g)).toHaveLength(2)
  for (const points of [[], [point(start, { equityUsd: null }), point(start + day)], [point(start), point(start + day, { equityUsd: null })]]) {
    expect(timelinePath(points, p => p.equityUsd, t => t, v => v).bridges).toBe('')
  }
})
