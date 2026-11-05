import { expect, it } from 'vitest'
import type { ChartCandle } from './indicators'
import { DEFAULT_UNTAKEN_SETTINGS, UntakenLevels, validUntakenSettings } from './untakenLevels'

const bar = (i: number, high = 101, low = 99, close = 100): ChartCandle => ({ time: (1704067200 + i * 60) as ChartCandle['time'], open: close, high, low, close })
const levels = (tracker: UntakenLevels, count = 1000) => tracker.visible(100, count)
const pivot = () => [bar(0), bar(1, 110, 90), bar(2)]
const nested = (count: number) => Array.from({ length: count * 3 }, (_, i) => i % 3 === 1 ? bar(i, 140 - Math.floor(i / 3) * 0.5, 60 + Math.floor(i / 3) * 0.5) : bar(i))

it('uses three wick highs/lows and retains one anchored ray through provisional confirmation', () => {
  const candles = pivot(), tracker = new UntakenLevels()
  tracker.update(candles.slice(0, 1), 0); expect(levels(tracker)).toEqual([])
  const expected = [{ side: 'high' as const, price: 110, time: candles[1].time }, { side: 'low' as const, price: 90, time: candles[1].time }]
  for (const completed of [1, 2, 3]) {
    tracker.update(candles.slice(0, Math.min(3, completed + 1)), completed)
    expect(levels(tracker)).toEqual(expected)
  }
})

it('detects smaller three-candle swings despite a higher high and lower low two candles to the left', () => {
  const candles = [bar(0, 120, 80), bar(1), bar(2, 102, 98), bar(3)], tracker = new UntakenLevels()
  tracker.update(candles, 4)
  expect(levels(tracker)).toEqual([{ time: candles[2].time, price: 102, side: 'high' }, { time: candles[2].time, price: 98, side: 'low' }])
})

it.each([0, 2])('rejects equal neighboring wick prices at index %s', neighbor => {
  const candles = pivot(), highTracker = new UntakenLevels(), lowTracker = new UntakenLevels()
  highTracker.update(candles.map((c, i) => i === neighbor ? { ...c, high: 110 } : c), 3)
  lowTracker.update(candles.map((c, i) => i === neighbor ? { ...c, low: 90 } : c), 3)
  expect(levels(highTracker).map(l => l.side)).toEqual(['low'])
  expect(levels(lowTracker).map(l => l.side)).toEqual(['high'])
})

it('compares wicks rather than closing prices and requires only one strictly weaker left candle', () => {
  const tracker = new UntakenLevels()
  tracker.update([bar(0), bar(1, 110, 90, 100)], 1)
  expect(levels(tracker).map(l => l.price)).toEqual([110, 90])
  tracker.update([bar(0, 120, 80), bar(1, 110, 90)], 1, true)
  expect(levels(tracker)).toEqual([])
  tracker.update([bar(0), bar(1, 101, 99)], 1, true)
  expect(levels(tracker)).toEqual([])
})

it('updates a forming provisional extreme without taking itself and combines it with confirmed levels under N', () => {
  const tracker = new UntakenLevels(), candles = pivot()
  tracker.update(candles, 3)
  const forming = [...candles, bar(3, 105, 95)]
  tracker.update(forming, 3)
  expect(levels(tracker, 1).map(l => [l.price, l.time])).toEqual([[105, forming[3].time], [95, forming[3].time]])
  expect(levels(tracker, 2).map(l => l.price)).toEqual([105, 110, 95, 90])
  forming[3] = bar(3, 111, 89)
  tracker.update(forming, 3)
  expect(levels(tracker).map(l => [l.price, l.time])).toEqual([[111, forming[3].time], [89, forming[3].time]])
  tracker.update(forming, 3); expect(levels(tracker)).toHaveLength(2)
  tracker.update(forming, 4); expect(levels(tracker)).toHaveLength(2)
})

it('discards a provisional on an equal next-candle wick and replaces it only when the new extreme qualifies', () => {
  const tracker = new UntakenLevels(), candles = pivot()
  tracker.update(candles.slice(0, 2), 2); expect(levels(tracker)).toHaveLength(2)
  tracker.update([...candles.slice(0, 2), bar(2, 110, 90)], 2)
  expect(levels(tracker)).toEqual([])
  const crossing = [...candles.slice(0, 2), bar(2, 111, 89)]
  tracker.update(crossing, 2)
  expect(levels(tracker).map(l => l.price)).toEqual([111, 89])
  expect(levels(tracker).every(l => l.time === crossing[2].time)).toBe(true)
  tracker.update(crossing, 3); expect(levels(tracker)).toHaveLength(2)
})

it('removes confirmed levels immediately on subsequent equal forming-wick touches', () => {
  const candles = [...pivot(), bar(3, 110, 90)], tracker = new UntakenLevels()
  tracker.update(candles.slice(0, 3), 3)
  tracker.update(candles, 3)
  expect(levels(tracker).map(l => l.price)).toEqual([110, 90])
  expect(levels(tracker).every(l => l.time === candles[3].time)).toBe(true)
})

it('selects nearest N distinct levels per side and retains hidden old levels when nearer levels are taken', () => {
  const candles = nested(30), tracker = new UntakenLevels()
  tracker.update(candles, candles.length)
  expect(DEFAULT_UNTAKEN_SETTINGS).toEqual({ enabled: false, count: 10 })
  expect(levels(tracker, 10).map(l => l.price)).toEqual([...Array.from({ length: 10 }, (_, i) => 125.5 + i * 0.5), ...Array.from({ length: 10 }, (_, i) => 74.5 - i * 0.5)])
  expect(levels(tracker, 10)).toHaveLength(20)
  expect(levels(tracker, 50)).toHaveLength(60)
  expect(levels(tracker, 10).some(l => l.time === candles[1].time)).toBe(false)
  candles.push(bar(90, 139.5, 60.5)); tracker.update(candles, 90)
  expect(levels(tracker, 2).map(l => l.price)).toEqual([139.5, 140, 60.5, 60])
  expect(levels(tracker, 2).filter(l => l.time === candles[1].time)).toHaveLength(2)
})

it('deduplicates repeated local prices at the later untaken origin', () => {
  const candles = [...pivot(), ...pivot().map((c, i) => ({ ...c, time: bar(i + 3).time }))], tracker = new UntakenLevels()
  tracker.update(candles, 6)
  expect(levels(tracker).map(l => l.price)).toEqual([110, 90])
  expect(levels(tracker).every(l => l.time === candles[4].time)).toBe(true)
})

it('filters strictly above/below current price without consuming slots on equal prices', () => {
  const candles = nested(3), tracker = new UntakenLevels(); tracker.update(candles, 9)
  expect(tracker.visible(139, 1).map(l => l.price)).toEqual([139.5, 61])
  expect(tracker.visible(61, 1).map(l => l.price)).toEqual([139, 60.5])
})

it('reconstructs backward replay across provisional birth, confirmation and forming-wick growth without look-ahead', () => {
  const candles = [...pivot(), bar(3, 111, 89)], tracker = new UntakenLevels()
  tracker.update(candles.slice(0, 1), 0); expect(levels(tracker)).toEqual([])
  tracker.update(candles.slice(0, 3), 2); const provisional = levels(tracker)
  tracker.update(candles.slice(0, 3), 3); expect(levels(tracker)).toEqual(provisional)
  tracker.update(candles, 3); expect(levels(tracker).map(l => l.price)).toEqual([111, 89])
  tracker.update(candles.slice(0, 3), 2, true); expect(levels(tracker)).toEqual(provisional)
  tracker.update([...candles.slice(0, 3), bar(3, 105, 95)], 3)
  expect(levels(tracker).map(l => l.price)).toEqual([105, 110, 95, 90])
  tracker.update(candles.slice(0, 1), 0, true); expect(levels(tracker)).toEqual([])
})

it('matches the direct three-candle/provisional definition through incremental steps and batched jumps', () => {
  const candles = Array.from({ length: 300 }, (_, i) => {
    const center = 100 + Math.sin(i * 1.3) * 4
    return bar(i, center + 1, center - 1, center)
  }), tracker = new UntakenLevels()
  for (const count of [1, 2, 3, 4, 20, 50, 100, 101, 200, 300]) {
    const revealed = candles.slice(0, count), price = revealed.at(-1)!.close
    tracker.update(revealed, count - 1)
    for (const limit of [1, 2, 10]) {
      const expected = (['high', 'low'] as const).flatMap(side => revealed.flatMap((c, i) => {
        if (!i) return []
        const strict = side === 'high' ? c.high > revealed[i - 1].high : c.low < revealed[i - 1].low
        const taken = revealed.slice(i + 1).some(n => side === 'high' ? n.high >= c.high : n.low <= c.low)
        return strict && !taken && (side === 'high' ? c.high > price : c.low < price) ? [{ time: c.time, price: c[side], side }] : []
      }).sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price)).slice(0, limit))
      expect(tracker.visible(price, limit)).toEqual(expected)
    }
  }
})

it('retains old untaken levels without a candle-age cutoff', () => {
  const candles = Array.from({ length: 2000 }, (_, i) => i === 1 ? bar(i, 110, 90) : bar(i)), tracker = new UntakenLevels()
  tracker.update(candles, candles.length)
  expect(levels(tracker).every(l => l.time === candles[1].time)).toBe(true)
  expect(levels(tracker).map(l => l.price)).toEqual([110, 90])
})

it('accepts only positive safe integer level counts and the current preference shape', () => {
  for (const count of [1, 10, 10001]) expect(validUntakenSettings({ enabled: false, count })).toBe(true)
  for (const count of [0, -1, 2.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '10', null, undefined]) expect(validUntakenSettings({ enabled: true, count })).toBe(false)
  expect(validUntakenSettings({ enabled: true, count: 15, pivotStrength: 20 })).toBe(false)
})
