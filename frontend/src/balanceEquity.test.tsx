// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { balanceEquityFixture } from '../../tests/balanceEquityFixture'
import { ResultsCharts, timelinePath } from './ResultsCharts'
import { continuousCashGaps, downsampleEquity, EquityDisplay, equityObservations, flatEquityGaps } from './equityDisplay'
import { createEquityLedger, type EquityPoint } from './equity'
import { equityPerformance, returnPercent } from './resultsAnalytics'
import { tradingTime } from './trading'
import { equitySuffix, restoreEquity } from './sessionCodec'
import { equitySummary } from './sessionTypes'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const point = (i: number, cashUsd = 10000, equityUsd: number | null = cashUsd): EquityPoint => ({
  timestamp: i * 60000, cashUsd, equityUsd, unrealizedUsd: equityUsd === null ? null : equityUsd - cashUsd,
  drawdownUsd: null, drawdownPercent: null, missingSides: equityUsd === null ? ['ask'] : [], clockGap: false,
})

it('renders entry fees, two independently timed closes and exit fees exactly from recorded cash', () => {
  const { state, ledger } = balanceEquityFixture(), all = equityObservations(ledger)
  expect(state.closed).toHaveLength(2)
  expect(all[0].cashUsd).toBe(10000)
  expect(all[1].cashUsd).toBe(9994.75) // $3.50 + $1.75 incurred at entry
  expect(new Set(all.slice(1, 30).map(p => p.cashUsd))).toEqual(new Set([9994.75]))
  expect(new Set(all.slice(1, 15).map(p => p.equityUsd)).size).toBeGreaterThan(1)
  expect(all[30].cashUsd).toBe(9994.75 + state.closed[0].grossPnlUsd - 3.5)
  expect(all[45].cashUsd).toBe(all[30].cashUsd + state.closed[1].grossPnlUsd - 1.75)
  expect(all.at(-1)!.equityUsd).toBe(all.at(-1)!.cashUsd)
  const sample = downsampleEquity(all, 1)
  for (const i of [0, 1, 29, 30, 44, 45]) expect(sample).toContain(all[i])
  const path = timelinePath(sample, p => p.cashUsd, t => t, v => v, continuousCashGaps(all, state.closed), 'balance')
  for (const i of [1, 30, 45]) expect(path.solid).toContain(`H${all[i].timestamp.toFixed(2)} V${all[i].cashUsd.toFixed(2)}`)
  expect(path.bridges).toBe('')
})

it('keeps cash continuous through missing marks and open-position market closures', () => {
  const { state, ledger } = balanceEquityFixture('open'), all = equityObservations(ledger)
  expect(state.positions).toHaveLength(2)
  expect(all[15].equityUsd).toBeNull(); expect(all[16].equityUsd).toBeNull()
  const cash = timelinePath(all, p => p.cashUsd, t => t, v => v, continuousCashGaps(all, state.positions), 'balance')
  const equity = timelinePath(all, p => p.equityUsd, t => t, v => v, flatEquityGaps(all, state.positions))
  expect(cash.solid.match(/M/g)).toHaveLength(1); expect(cash.bridges).toBe('')
  expect(equity.bridges.match(/M/g)).toHaveLength(2)
  expect(cash.solid).toContain(`H${all[15].timestamp.toFixed(2)} V9994.75`)
})

it('distinguishes unknown cash intervals without drawing ramps or inventing transaction times', () => {
  const all = [point(0), { ...point(10, 9900), clockGap: true }]
  const inside = [{ entryTime: 300000, exitTime: 400000 }]
  expect(continuousCashGaps(all, inside).size).toBe(0)
  const path = timelinePath(all, p => p.cashUsd, t => t, v => v, continuousCashGaps(all, inside), 'balance')
  expect(path.solid.match(/M/g)).toHaveLength(2); expect(path.bridges).toBe('')
  const right = [{ entryTime: 600000 }]
  expect(continuousCashGaps(all, right).has(600000)).toBe(true)
  expect(timelinePath(all, p => p.cashUsd, t => t, v => v, continuousCashGaps(all, right), 'balance').solid).toContain('H600000.00 V9900.00')
  const equal = [all[0], { ...all[1], cashUsd: 10000 }]
  expect(timelinePath(equal, p => p.cashUsd, t => t, v => v, continuousCashGaps(equal, inside), 'balance').bridges).toBe('M0.00,10000.00 L600000.00,10000.00')
  const invalid = [point(0), point(1, NaN), point(2, 9900)]
  expect(timelinePath(invalid, p => p.cashUsd, t => t, v => v, undefined, 'balance').solid).not.toMatch(/NaN|Infinity/)
})

it('retains every cash change and its actual preceding observation in a 90-day M1 display and cache', () => {
  const all = Array.from({ length: 90 * 1440 }, (_, i) => point(i, 10000 - Math.floor(i / 91) * .5, i % 701 === 0 ? null : 10000 + Math.sin(i)))
  let ledger = createEquityLedger(10000)
  for (const p of all) ledger = { ...ledger, count: ledger.count + 1, tail: { point: p, previous: ledger.tail } }
  const before = equityPerformance(ledger, 10000), original = ledger.tail
  for (const sample of [downsampleEquity(all, 700), new EquityDisplay().update(ledger, 700)]) {
    const kept = new Set(sample)
    for (let i = 1; i < all.length; i++) if (all[i].cashUsd !== all[i - 1].cashUsd) {
      expect(kept.has(all[i])).toBe(true); expect(kept.has(all[i - 1])).toBe(true)
    }
    expect(sample.length).toBeLessThan(6000)
    const path = timelinePath(sample, p => p.cashUsd, t => t, v => v, undefined, 'balance')
    const steps = [...path.solid.matchAll(/H([\d.]+) V([\d.]+)/g)]
    for (const match of steps) {
      const actual = all[Number(match[1]) / 60000]
      expect(Number(match[2])).toBe(actual.cashUsd)
    }
  }
  expect(ledger.count).toBe(129600); expect(ledger.tail).toBe(original)
  expect(equityPerformance(ledger, 10000)).toEqual(before)
  expect(equityObservations(ledger)).toEqual(all)
})

describe('Balance & Equity rendering and inspection', () => {
  async function chart(kind: Parameters<typeof balanceEquityFixture>[0] = 'open', replacement?: EquityPoint[]) {
    const fixture = balanceEquityFixture(kind)
    let ledger = fixture.ledger
    if (replacement) {
      ledger = createEquityLedger(10000)
      for (const p of replacement) ledger = { ...ledger, count: ledger.count + 1, tail: { point: p, previous: ledger.tail } }
    }
    const host = document.createElement('div'), root = createRoot(host)
    await act(async () => root.render(<ResultsCharts ledger={ledger} positions={[...fixture.state.positions, ...fixture.state.closed]} referenceBalance={10000} observations={[]} start={fixture.start} endpoint={fixture.endpoint} />))
    return { host, fixture, stop: () => act(async () => root.unmount()), key: (key: string) => act(async () => host.querySelector('.results-timeline')!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))) }
  }
  it.each(['empty', 'closed', 'open', 'missing'] as const)('displays both series, units and synchronized real timestamps for %s sessions', async kind => {
    const { host, fixture, stop, key } = await chart(kind)
    const before = equityObservations(fixture.ledger), kpis = equityPerformance(fixture.ledger, 10000)
    const saved = JSON.stringify(equitySuffix(fixture.ledger, 0)), summary = equitySummary(fixture.ledger)
    try {
      expect(host.querySelector('.results-account-chart')!.getAttribute('aria-label')).toBe('Balance & Equity')
      expect(host.querySelector('.results-account-chart .results-chart-legend')!.textContent).toBe('BalanceEquity')
      expect(host.querySelector('.results-balance-line')!.getAttribute('d')).not.toBe('')
      await key('End')
      const readout = host.querySelector('.results-chart-readout')!.textContent!
      expect(readout).toContain(tradingTime(fixture.endpoint!)); expect(readout).toContain('Balance $')
      if (kind === 'missing') expect(readout).toContain('Equity N/A (N/A) · Floating PnL N/A')
      else expect(readout).toMatch(/Floating PnL [+-]?\$/)
      const times = [...host.querySelectorAll('.results-chart-readout time')].map(t => t.textContent)
      expect(times[0]).toBe(times[1])
      const usd = [...host.querySelectorAll('button')].find(b => b.textContent === 'USD')!
      await act(async () => usd.click())
      expect(usd.getAttribute('aria-pressed')).toBe('true')
      expect(host.querySelector('.results-timeline')!.getAttribute('aria-label')).toContain('USD')
      expect(host.querySelector('.results-chart-readout')!.textContent).toBe(readout)
      await key('Home'); expect(host.querySelector('time')!.textContent).toBe(tradingTime(before[0].timestamp))
      await key('ArrowRight'); expect(host.querySelector('time')!.textContent).toBe(tradingTime(before[1].timestamp))
      await key('Escape'); expect(host.querySelectorAll('.results-crosshair')).toHaveLength(0)
      expect(equityPerformance(fixture.ledger, 10000)).toEqual(kpis)
      expect(equityObservations(fixture.ledger)).toEqual(before)
      expect(JSON.stringify(equitySuffix(fixture.ledger, 0))).toBe(saved)
      expect(equityObservations(restoreEquity(JSON.parse(saved), summary, 10000))).toEqual(before)
    } finally { await stop() }
  })
  it.each(['usd', 'percent'])('scales both series together when cash and equity extrema differ in %s', async unit => {
    const points = [point(0, 2000, 15000), point(1, 30000, null), point(2, 30000, 5000)]
    const { host, stop } = await chart('empty', points)
    try {
      if (unit === 'usd') await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'USD')!.click())
      const svg = host.querySelector('.results-timeline')!, toValue = unit === 'usd' ? (v: number) => v : (v: number) => returnPercent(v, 10000)!
      const min = toValue(2000), max = toValue(30000), padding = (max - min) * .08
      const y = (v: number) => 16 + (max + padding - toValue(v)) / (max - min + 2 * padding) * 202
      expect(svg.querySelector('.results-balance-line')!.getAttribute('d')).toContain(`M80.00,${y(2000).toFixed(2)}`)
      expect(svg.querySelector('.results-balance-line')!.getAttribute('d')).toContain(`V${y(30000).toFixed(2)}`)
      expect(svg.querySelector('.results-equity-line')!.getAttribute('d')).toContain(`M80.00,${y(15000).toFixed(2)}`)
      expect(svg.innerHTML).not.toMatch(/NaN|Infinity/)
    } finally { await stop() }
  })
})
