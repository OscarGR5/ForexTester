import { expect, it } from 'vitest'
import type { ChartCandle } from './indicators'
import { DEFAULT_UNTAKEN_SETTINGS, UntakenLevels, validUntakenSettings } from './untakenLevels'

const bar = (i: number, high = 101, low = 99, close = 100): ChartCandle => ({ time: (1704067200 + i * 60) as ChartCandle['time'], open: close, high, low, close })
const levels = (tracker: UntakenLevels, count = 1000) => tracker.visible(100, count)
const pivot = () => [bar(0), bar(1), bar(2, 110, 90), bar(3), bar(4)]
const nested = (count: number) => Array.from({ length: count * 5 }, (_, i) => i % 5 === 2 ? bar(i, 140 - Math.floor(i / 5) * 0.5, 60 + Math.floor(i / 5) * 0.5) : bar(i))

it('confirms strict local highs/lows only after both right-side candles close and anchors to the pivot', () => {
  const candles = pivot(), tracker = new UntakenLevels()
  // Even if the caller has later data, only completed candles can confirm.
  for (const completed of [1, 2, 3, 4]) {
    tracker.update(candles.slice(0, completed + 1), completed)
    expect(levels(tracker)).toEqual([])
  }
  tracker.update(candles, 5)
  expect(levels(tracker)).toEqual([
    { side: 'high', price: 110, time: candles[2].time },
    { side: 'low', price: 90, time: candles[2].time },
  ])
})

it.each([1, 2, 3, 4])('rejects equal highs and lows at neighboring index %s', index => {
  const candles = pivot(), highTracker = new UntakenLevels(), lowTracker = new UntakenLevels()
  const neighbor = index <= 2 ? index - 1 : index
  highTracker.update(candles.map((c, i) => i === neighbor ? { ...c, high: 110 } : c), 5)
  lowTracker.update(candles.map((c, i) => i === neighbor ? { ...c, low: 90 } : c), 5)
  expect(levels(highTracker).map(l => l.side)).toEqual(['low'])
  expect(levels(lowTracker).map(l => l.side)).toEqual(['high'])
})

it('rejects ordinary and edge candles and honors different pivot strengths', () => {
  const monotonic = Array.from({ length: 30 }, (_, i) => bar(i, 110 + i, 90 + i, 100 + i))
  const tracker = new UntakenLevels(); tracker.update(monotonic, monotonic.length)
  expect(tracker.visible(100, 10)).toEqual([])
  const candles = [bar(0, 120, 80), bar(1), bar(2, 110, 90), bar(3), bar(4)]
  const weak = new UntakenLevels(1), strong = new UntakenLevels(2)
  weak.update(candles, 5); strong.update(candles, 5)
  expect(levels(weak).map(l => l.price)).toEqual([110, 90])
  expect(levels(strong)).toEqual([])
})

it('removes confirmed pivots immediately on equal forming-wick touches, including at confirmation', () => {
  const candles = [...pivot(), bar(5, 110, 90)], tracker = new UntakenLevels()
  tracker.update(candles.slice(0, 5), 5)
  expect(levels(tracker)).toHaveLength(2)
  tracker.update(candles, 5)
  expect(levels(tracker)).toEqual([])
  const fresh = new UntakenLevels(); fresh.update(candles, 5)
  expect(levels(fresh)).toEqual([])
})

it('selects N nearest distinct confirmed pivots per side and retains hidden older pivots', () => {
  const candles = nested(30), tracker = new UntakenLevels()
  tracker.update(candles, candles.length)
  expect(DEFAULT_UNTAKEN_SETTINGS).toEqual({ enabled: false, count: 10, pivotStrength: 2 })
  expect(levels(tracker, 10).map(l => l.price)).toEqual([
    ...Array.from({ length: 10 }, (_, i) => 125.5 + i * 0.5),
    ...Array.from({ length: 10 }, (_, i) => 74.5 - i * 0.5),
  ])
  expect(levels(tracker, 10)).toHaveLength(20)
  expect(levels(tracker, 50)).toHaveLength(60)
  expect(levels(tracker, 10).some(l => l.time === candles[2].time)).toBe(false)
  candles.push(bar(150, 139.5, 60.5)); tracker.update(candles, 150)
  expect(levels(tracker, 1).map(l => l.price)).toEqual([140, 60])
  expect(levels(tracker, 1).every(l => l.time === candles[2].time)).toBe(true)
})

it('shows one line for repeated pivot prices, with the later confirmed pivot replacing the taken one', () => {
  const candles = [...pivot(), ...pivot().map((c, i) => ({ ...c, time: bar(i + 5).time }))], tracker = new UntakenLevels()
  tracker.update(candles, 10)
  expect(levels(tracker).map(l => l.price)).toEqual([110, 90])
  expect(levels(tracker).every(l => l.time === candles[7].time)).toBe(true)
})

it('filters strictly above/below current price without consuming slots on equal prices', () => {
  const candles = nested(3), tracker = new UntakenLevels(); tracker.update(candles, 15)
  expect(tracker.visible(139, 1).map(l => l.price)).toEqual([139.5, 61])
  expect(tracker.visible(61, 1).map(l => l.price)).toEqual([139, 60.5])
})

it('reconstructs backward review across confirmation and shrinking forming wicks without future leakage', () => {
  const candles = [...pivot(), bar(5, 110, 90)], tracker = new UntakenLevels()
  tracker.update(candles.slice(0, 5), 4); expect(levels(tracker)).toEqual([])
  tracker.update(candles.slice(0, 5), 5); const confirmed = levels(tracker)
  expect(confirmed).toHaveLength(2)
  tracker.update(candles, 5); expect(levels(tracker)).toEqual([])
  tracker.update(candles.slice(0, 5), 5, true); expect(levels(tracker)).toEqual(confirmed)
  tracker.update(candles.slice(0, 5), 4, true); expect(levels(tracker)).toEqual([])
  const smallerWick = [...candles.slice(0, 5), bar(5)]
  tracker.update(smallerWick, 5); expect(levels(tracker)).toEqual(confirmed)
})

// Independent direct definition: strict neighbors, confirmed right candles,
// subsequent touches, then nearest prices. Kept small, not a benchmark.
it.each([1, 2, 5, 20])('matches a direct historical oracle through incremental and batched updates with strength %s', strength => {
  const candles = Array.from({ length: 300 }, (_, i) => {
    const center = 100 + Math.sin(i * 1.3) * 4
    return bar(i, center + 1, center - 1, center)
  })
  const tracker = new UntakenLevels(strength)
  for (const count of [1, 4, 5, 20, 50, 100, 101, 200, 300]) {
    const revealed = candles.slice(0, count), completed = count - 1, price = revealed.at(-1)!.close
    tracker.update(revealed, completed)
    for (const limit of [1, 2, 10]) {
      const expected = (['high', 'low'] as const).flatMap(side => revealed.slice(0, completed).flatMap((c, i) => {
        if (i < strength || i + strength >= completed) return []
        const neighbors = revealed.slice(i - strength, i + strength + 1).filter((_, offset) => offset !== strength)
        const strict = neighbors.every(n => side === 'high' ? n.high < c.high : n.low > c.low)
        const taken = revealed.slice(i + 1).some(n => side === 'high' ? n.high >= c.high : n.low <= c.low)
        return strict && !taken && (side === 'high' ? c.high > price : c.low < price) ? [{ time: c.time, price: c[side], side }] : []
      }).sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price)).slice(0, limit))
      expect(tracker.visible(price, limit)).toEqual(expected)
    }
  }
})

it('compacts expired rolling-window entries without losing an old confirmed level', () => {
  const candles = Array.from({ length: 6000 }, (_, i) => i === 3000 ? bar(i, 110, 90) : bar(i))
  const tracker = new UntakenLevels(); tracker.update(candles, candles.length)
  expect(levels(tracker).map(l => l.price)).toEqual([110, 90])
  expect(levels(tracker).every(l => l.time === candles[3000].time)).toBe(true)
})

it('accepts only positive safe integer counts and strengths', () => {
  for (const value of [1, 2, 10, 10001]) expect(validUntakenSettings({ enabled: false, count: value, pivotStrength: value })).toBe(true)
  for (const invalid of [0, -1, 2.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', null, undefined]) {
    expect(validUntakenSettings({ enabled: true, count: 10, pivotStrength: invalid })).toBe(false)
    expect(validUntakenSettings({ enabled: true, count: invalid, pivotStrength: 2 })).toBe(false)
  }
})
