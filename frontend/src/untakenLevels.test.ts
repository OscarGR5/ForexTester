import { expect, it } from 'vitest'
import type { ChartCandle } from './indicators'
import { UntakenLevels, validUntakenSettings } from './untakenLevels'

const bar = (i: number, high: number, low: number, close = (high + low) / 2): ChartCandle => ({ time: (1704067200 + i * 60) as ChartCandle['time'], open: close, high, low, close })
const warmup = () => Array.from({ length: 15 }, (_, i) => bar(i, 101, 99))
const levels = (tracker: UntakenLevels, multiplier = 100) => tracker.visible(100, multiplier)

it('keeps individual candle levels, removes equal wick touches, and never self-invalidates', () => {
  const tracker = new UntakenLevels(), candles = [...warmup(), bar(15, 103, 97), bar(16, 102, 98), bar(17, 101.5, 98.5)]
  tracker.update(candles, candles.length)
  expect(levels(tracker).map(l => [l.side, l.price])).toEqual([['high', 101.5], ['high', 102], ['high', 103], ['low', 98.5], ['low', 98], ['low', 97]])
  candles.push(bar(18, 102, 98))
  tracker.update(candles, 18) // Forming candle takes equals through wicks.
  expect(levels(tracker).map(l => [l.side, l.price])).toEqual([['high', 103], ['low', 97]])
  tracker.update(candles, 19)
  expect(levels(tracker).filter(l => l.time === candles[18].time).map(l => l.price)).toEqual([102, 98])
})

it('filters in price units with Wilder ATR(14), including the boundary and decimal multipliers', () => {
  const tracker = new UntakenLevels(), candles = warmup() // Fourteen TRs of 2.
  tracker.update(candles, 15)
  expect(levels(tracker, 0.49)).toEqual([])
  expect(levels(tracker, 0.5).map(l => l.price)).toEqual([101, 99])
  expect(levels(tracker, 2.5)).toEqual(levels(tracker, 7.5))
  const next = bar(15, 103, 97)
  candles.push(next); tracker.update(candles, 16)
  const atr = (2 * 13 + 6) / 14
  expect(levels(tracker, (3 - 1e-8) / atr)).toEqual([])
  expect(levels(tracker, (3 + 1e-8) / atr).map(l => l.price)).toEqual([103, 97])
})

it('retains old hidden levels and reveals them when distance or current price changes', () => {
  const candles = [bar(0, 120, 80), ...Array.from({ length: 2000 }, (_, i) => bar(i + 1, 102 - i * 0.0001, 98 + i * 0.0001))]
  const tracker = new UntakenLevels(); tracker.update(candles, candles.length)
  expect(levels(tracker, 2.5).some(l => l.time === candles[0].time)).toBe(false)
  expect(levels(tracker, 7.5).filter(l => l.time === candles[0].time)).toHaveLength(2)
  expect(tracker.visible(119, 0.5).some(l => l.time === candles[0].time && l.side === 'high')).toBe(true)
  expect(levels(tracker, 2.5).some(l => l.time === candles[0].time)).toBe(false)
})

it('has no future leakage and reconstructs backward review, including a shrinking forming wick', () => {
  const candles = [...warmup(), bar(15, 105, 95), bar(16, 104, 96), bar(17, 106, 94)]
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
  const candles = [...warmup(), ...Array.from({ length: 300 }, (_, i) => {
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
    expect(levels(tracker).map(l => `${l.side}:${l.time}:${l.price}`).sort()).toEqual(expected)
  }
})

it('requires fourteen completed true ranges and validates positive finite settings', () => {
  const tracker = new UntakenLevels(); tracker.update(warmup(), 14)
  expect(levels(tracker)).toEqual([])
  expect(validUntakenSettings({ enabled: false, distanceAtr: 2.5 })).toBe(true)
  for (const distanceAtr of [0, -1, NaN, Infinity, '5', null]) expect(validUntakenSettings({ enabled: true, distanceAtr })).toBe(false)
})
