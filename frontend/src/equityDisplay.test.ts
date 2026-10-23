import { describe, expect, it } from 'vitest'
import { EquityDisplay, downsampleEquity, equityObservations } from './equityDisplay'
import { createEquityLedger, type EquityLedger, type EquityPoint } from './equity'
function append(ledger: EquityLedger, index: number): EquityLedger {
  const equityUsd = index % 701 === 0 ? null : 10000 + Math.sin(index / 17) * (index % 199)
  const point: EquityPoint = { timestamp: index * 60000 + (index >= 6000 ? 172800000 : 0), equityUsd,
    cashUsd: 10000 - Math.floor(index / 91), unrealizedUsd: equityUsd === null ? null : equityUsd - 10000,
    drawdownUsd: equityUsd === null ? null : 10200 - equityUsd, drawdownPercent: null,
    missingSides: equityUsd === null ? ['ask'] : [], clockGap: index === 6000 }
  return { ...ledger, count: ledger.count + 1, tail: { point, previous: ledger.tail } }
}
describe('incremental equity display cache', () => {
  it('preserves financial extrema, gap boundaries and the latest observation through long appends', () => {
    const display = new EquityDisplay()
    let ledger = createEquityLedger(10000)
    for (let index = 0; index < 12000; index++) {
      ledger = append(ledger, index)
      if (index % 100 !== 0 && index !== 11999) continue
      const actual = display.update(ledger, 390), all = equityObservations(ledger)
      expect(actual.at(-1)).toBe(ledger.tail!.point)
      const values = (key: 'equityUsd' | 'cashUsd' | 'drawdownUsd', points: EquityPoint[]) => points.flatMap(p => p[key] === null ? [] : [p[key]!])
      for (const key of ['equityUsd', 'cashUsd', 'drawdownUsd'] as const) {
        expect(Math.min(...values(key, actual))).toBe(Math.min(...values(key, all)))
        expect(Math.max(...values(key, actual))).toBe(Math.max(...values(key, all)))
      }
      const times = new Set(actual.map(p => p.timestamp))
      for (let i = 1; i < all.length; i++) if (all[i].clockGap || (all[i].equityUsd === null) !== (all[i - 1].equityUsd === null)) {
        expect(times.has(all[i].timestamp)).toBe(true); expect(times.has(all[i - 1].timestamp)).toBe(true)
      }
      expect(actual.every((p, i) => !i || p.timestamp > actual[i - 1].timestamp)).toBe(true)
      expect(display.update(ledger, 390)).toEqual(actual)
    }
  })
  it('rebuilds on restart, a same-sized independent ledger, and a branched abandoned render', () => {
    const display = new EquityDisplay(), initial = createEquityLedger(10000)
    let ledger = initial
    for (let i = 0; i < 8000; i++) ledger = append(ledger, i)
    const earlier = ledger
    display.update(ledger, 280)
    ledger = append(ledger, 8000); display.update(ledger, 280)
    expect(display.update(earlier, 280).at(-1)).toBe(earlier.tail!.point)
    const branch = append(earlier, 9000)
    expect(display.update(branch, 280).at(-1)).toBe(branch.tail!.point)
    expect(display.update(initial, 280)).toEqual([])
    let independent = initial
    for (let i = 0; i < 8000; i++) independent = append(independent, i + 12000)
    expect(display.update(independent, 280).at(-1)).toBe(independent.tail!.point)
    expect(display.update(independent, 10000)).toEqual(equityObservations(independent))
  })
  it('retains the existing full-resolution short-history display', () => {
    const display = new EquityDisplay(); let ledger = createEquityLedger(10000)
    for (let i = 0; i < 800; i++) ledger = append(ledger, i)
    expect(display.update(ledger, 390)).toEqual(downsampleEquity(equityObservations(ledger), 390))
  })
})
