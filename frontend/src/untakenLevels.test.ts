import { expect, it } from 'vitest'
import type { ChartCandle } from './indicators'
import { DEFAULT_UNTAKEN_SETTINGS, UntakenLevels, validUntakenSettings } from './untakenLevels'

const bar = (i: number, high: number, low: number, close = (high + low) / 2): ChartCandle => ({ time: (1704067200 + i * 60) as ChartCandle['time'], open: close, high, low, close })
const prefix = () => Array.from({ length: 15 }, (_, i) => bar(i, 101, 99))
const levels = (tracker: UntakenLevels, count = 1000) => tracker.visible(100, count)

it('keeps individual candle levels, removes equal wick touches, and never self-invalidates', () => {
  const tracker = new UntakenLevels(), candles = [...prefix(), bar(15, 103, 97), bar(16, 102, 98), bar(17, 101.5, 98.5)]
  tracker.update(candles, candles.length)
  expect(levels(tracker).map(l => [l.side, l.price])).toEqual([['high', 101.5], ['high', 102], ['high', 103], ['low', 98.5], ['low', 98], ['low', 97]])
  candles.push(bar(18, 102, 98))
  tracker.update(candles, 18) // Forming candle takes equals through wicks.
  expect(levels(tracker).map(l => [l.side, l.price])).toEqual([['high', 103], ['low', 97]])
  tracker.update(candles, 19)
  expect(levels(tracker).filter(l => l.time === candles[18].time).map(l => l.price)).toEqual([102, 98])
})

it('selects the nearest N distinct prices per side, with a default maximum of twenty lines', () => {
  const candles = Array.from({ length: 30 }, (_, i) => bar(i, 140 - i, 60 + i))
  const tracker = new UntakenLevels(); tracker.update(candles, candles.length)
  expect(DEFAULT_UNTAKEN_SETTINGS).toEqual({ enabled: false, count: 10 })
  expect(levels(tracker, 10).map(l => l.price)).toEqual([
    ...Array.from({ length: 10 }, (_, i) => 111 + i),
    ...Array.from({ length: 10 }, (_, i) => 89 - i),
  ])
  expect(levels(tracker, 1).map(l => l.price)).toEqual([111, 89])
  expect(levels(tracker, 50)).toHaveLength(60)
  expect(levels(tracker, 10)).toHaveLength(20)
})

it('excludes current-price levels and selects the next nearest level without consuming a slot', () => {
  const tracker = new UntakenLevels(), candles = [bar(0, 200, 0), bar(1, 150, 50), bar(2, 125, 75)]
  tracker.update(candles, candles.length)
  expect(tracker.visible(125, 1).map(l => l.price)).toEqual([150, 75])
  expect(tracker.visible(75, 1).map(l => l.price)).toEqual([125, 50])
})

it('shows one line per identical price and retains the latest untouched origin', () => {
  const candles = [bar(0, 110, 90), bar(1, 110, 90), bar(2, 105, 95)]
  const tracker = new UntakenLevels(); tracker.update(candles, candles.length)
  expect(levels(tracker).map(l => l.price)).toEqual([105, 110, 95, 90])
  expect(levels(tracker).filter(l => l.price === 110 || l.price === 90).map(l => l.time)).toEqual([candles[1].time, candles[1].time])
})

it('retains all old hidden levels and reveals them when N grows or nearer levels are taken', () => {
  const candles = [bar(0, 150, 50), ...Array.from({ length: 2000 }, (_, i) => bar(i + 1, 130 - i * 0.01, 70 + i * 0.01))]
  const tracker = new UntakenLevels(); tracker.update(candles, candles.length)
  expect(levels(tracker, 10)).toHaveLength(20)
  expect(levels(tracker, 10).some(l => l.time === candles[0].time)).toBe(false)
  expect(levels(tracker, 2001).filter(l => l.time === candles[0].time)).toHaveLength(2)
  candles.push(bar(2001, 140, 60)); tracker.update(candles, 2001)
  expect(levels(tracker, 1).map(l => l.price)).toEqual([150, 50])
})

it('has no future leakage and reconstructs backward review, including a shrinking forming wick', () => {
  const candles = [...prefix(), bar(15, 105, 95), bar(16, 104, 96), bar(17, 106, 94)]
  const tracker = new UntakenLevels()
  tracker.update(candles.slice(0, 17), 16)
  const before = levels(tracker)
  expect(before.map(l => l.price)).toEqual([105, 95])
  tracker.update(candles, 17)
  expect(levels(tracker)).toEqual([])
  tracker.update(candles.slice(0, 17), 16, true)
  expect(levels(tracker)).toEqual(before)
  const smallerWick = [...candles.slice(0, 17), bar(17, 103, 97)]
  tracker.update(smallerWick, 17)
  const reconstructed = new UntakenLevels(); reconstructed.update(smallerWick, 17)
  expect(levels(tracker)).toEqual(levels(reconstructed))
})

it('matches a direct historical definition through incremental steps and batched jumps', () => {
  const candles = [...prefix(), ...Array.from({ length: 300 }, (_, i) => {
    const center = 100 + Math.sin(i * 1.3) * 4
    return bar(i + 15, center + 1, center - 1)
  })]
  const tracker = new UntakenLevels()
  for (const count of [15, 16, 20, 100, 101, 200, 315]) {
    const revealed = candles.slice(0, count), completed = count - 1
    tracker.update(revealed, completed)
    const expected = revealed.slice(0, completed).flatMap((c, i) => [
      ...(!revealed.slice(i + 1).some(next => next.high >= c.high) ? [`high:${c.time}:${c.high}`] : []),
      ...(!revealed.slice(i + 1).some(next => next.low <= c.low) ? [`low:${c.time}:${c.low}`] : []),
    ]).sort()
    expect(tracker.visible(revealed.at(-1)!.close, 1000).map(l => `${l.side}:${l.time}:${l.price}`).sort()).toEqual(expected)
    for (const count of [1, 2, 10]) {
      const price = revealed.at(-1)!.close
      const nearest = ['high', 'low'].flatMap(side => expected.map(key => {
        const [kind, time, value] = key.split(':'); return { side: kind, time: Number(time), price: Number(value) }
      }).filter(level => level.side === side && (side === 'high' ? level.price > price : level.price < price))
        .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price)).slice(0, count)
        .map(level => `${level.side}:${level.time}:${level.price}`)).sort()
      expect(tracker.visible(price, count).map(l => `${l.side}:${l.time}:${l.price}`).sort()).toEqual(nearest)
    }
  }
})

it('has no warm-up requirement and accepts only positive safe integer limits', () => {
  const tracker = new UntakenLevels(); tracker.update([bar(0, 101, 99)], 1)
  expect(levels(tracker, 10).map(l => l.price)).toEqual([101, 99])
  for (const count of [1, 10, 25, 10001]) expect(validUntakenSettings({ enabled: false, count })).toBe(true)
  for (const count of [0, -1, 2.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '10', null]) expect(validUntakenSettings({ enabled: true, count })).toBe(false)
})
