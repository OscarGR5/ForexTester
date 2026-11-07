import { expect, it } from 'vitest'
import type { ChartCandle } from './indicators'
import { DEFAULT_UNTAKEN_SETTINGS, UntakenLevels, validUntakenSettings } from './untakenLevels'

const bar = (i: number, high = 101, low = 99, close = 100): ChartCandle => ({ time: (1704067200 + i * 60) as ChartCandle['time'], open: close, high, low, close })
const levels = (tracker: UntakenLevels, count = 1000) => tracker.visible(100, count)
const pivot = () => [bar(0), bar(1, 110, 90), bar(2)]
const nested = (count: number) => Array.from({ length: count * 3 }, (_, i) => i % 3 === 1 ? bar(i, 140 - Math.floor(i / 3) * 0.5, 60 + Math.floor(i / 3) * 0.5) : bar(i))
const expected = (candles: readonly ChartCandle[], completed: number, price = 100, limit = 10) =>
  (['high', 'low'] as const).flatMap(side => candles.flatMap((c, i) => {
    if (i === 0 || i >= completed) return []
    const value = c[side], left = candles[i - 1][side]
    if (!(side === 'high' ? value > left : value < left)) return []
    let right = i + 1
    while (right < completed && candles[right][side] === value) right++
    if (right >= completed || !(side === 'high' ? candles[right][side] < value : candles[right][side] > value)) return []
    if (candles.slice(right + 1).some(next => side === 'high' ? next.high >= value : next.low <= value)) return []
    if (!(side === 'high' ? value > price : value < price)) return []
    return [{ time: c.time, price: value, side }]
  }).sort((a, b) => side === 'high' ? a.price - b.price : b.price - a.price).slice(0, limit))

it('requires a closed right-hand candle before drawing a three-candle local high or low', () => {
  const candles = pivot(), tracker = new UntakenLevels()
  const confirmed = [{ time: candles[1].time, price: 110, side: 'high' }, { time: candles[1].time, price: 90, side: 'low' }]
  tracker.update(candles.slice(0, 1), 1)
  expect(levels(tracker)).toEqual([])
  tracker.update(candles.slice(0, 2), 1)
  expect(levels(tracker)).toEqual([])
  tracker.update(candles.slice(0, 2), 2)
  expect(levels(tracker)).toEqual([])
  tracker.update(candles, 2)
  expect(levels(tracker)).toEqual([]) // Weaker right candle is still forming.
  tracker.update(candles, 3)
  expect(levels(tracker)).toEqual(confirmed)
})

it('never plots the latest candle merely because it exceeds the previous candle', () => {
  const tracker = new UntakenLevels()
  tracker.update([bar(0), bar(1, 110, 90)], 2)
  expect(levels(tracker)).toEqual([])
  tracker.update([bar(0), bar(1, 110, 90), bar(2, 120, 80)], 3)
  expect(levels(tracker)).toEqual([])
  tracker.update([bar(0), bar(1, 110, 90), bar(2, 120, 80), bar(3)], 4)
  expect(levels(tracker).map(l => [l.time, l.price])).toEqual([[bar(2).time, 120], [bar(2).time, 80]])
})

it.each([1, 2, 3, 8])('confirms a %i-candle plateau only after a weaker right candle closes, anchored to its first wick', length => {
  const candles = [bar(0), ...Array.from({ length }, (_, i) => bar(i + 1, 110, 90)), bar(length + 1)]
  const tracker = new UntakenLevels()
  for (let closed = 1; closed < candles.length; closed++) {
    tracker.update(candles.slice(0, closed + 1), closed)
    expect(levels(tracker)).toEqual([])
  }
  tracker.update(candles, candles.length)
  expect(levels(tracker)).toEqual([{ time: bar(1).time, price: 110, side: 'high' }, { time: bar(1).time, price: 90, side: 'low' }])
})

it('rejects a plateau without a strictly weaker left neighbor', () => {
  const tracker = new UntakenLevels()
  tracker.update([bar(0, 110, 90), bar(1, 110, 90), bar(2), bar(3)], 4)
  expect(levels(tracker)).toEqual([])
})

it('rejects a candidate taken before confirmation, then confirms the later true pivot', () => {
  const tracker = new UntakenLevels(), candles = [bar(0), bar(1, 110, 90), bar(2, 111, 89), bar(3)]
  tracker.update(candles.slice(0, 3), 3)
  expect(levels(tracker)).toEqual([])
  tracker.update(candles, 4)
  expect(levels(tracker).map(l => l.time)).toEqual([bar(2).time, bar(2).time])
})

it('tracks independent high and low plateau boundaries', () => {
  const candles = [bar(0, 106, 95), bar(1, 110, 90), bar(2, 110, 92), bar(3, 110, 91), bar(4, 107, 94)]
  const tracker = new UntakenLevels()
  tracker.update(candles, candles.length)
  expect(levels(tracker)).toEqual([
    { time: candles[1].time, price: 110, side: 'high' },
    { time: candles[3].time, price: 91, side: 'low' },
    { time: candles[1].time, price: 90, side: 'low' },
  ])
})

it('takes an existing confirmed level immediately on a forming equal wick, without drawing a new last-candle level', () => {
  const candles = pivot(), tracker = new UntakenLevels()
  tracker.update(candles, 3)
  expect(levels(tracker)).toHaveLength(2)
  const touching = [...candles, bar(3, 110, 90)]
  tracker.update(touching, 3)
  expect(levels(tracker)).toEqual([])
  tracker.update(touching, 4)
  expect(levels(tracker)).toEqual([])
  tracker.update([...touching, bar(4)], 5)
  expect(levels(tracker).map(l => l.time)).toEqual([bar(3).time, bar(3).time])
})

it('tracks smaller local swings even when older candles have more extreme highs and lows', () => {
  const candles = [bar(0, 120, 80), bar(1), bar(2, 102, 98), bar(3)], tracker = new UntakenLevels()
  tracker.update(candles, 4)
  expect(levels(tracker).map(l => l.price)).toEqual([102, 98])
})

it('retains nearest N historical levels and excludes unconfirmed latest-bar candidates', () => {
  const candles = nested(30), tracker = new UntakenLevels()
  tracker.update(candles, candles.length)
  expect(DEFAULT_UNTAKEN_SETTINGS).toEqual({ enabled: false, count: 10 })
  expect(levels(tracker, 10).map(l => l.price)).toEqual([
    ...Array.from({ length: 10 }, (_, i) => 125.5 + i * 0.5),
    ...Array.from({ length: 10 }, (_, i) => 74.5 - i * 0.5),
  ])
  expect(levels(tracker, 50)).toHaveLength(60)
  const next = bar(90, 139.5, 60.5)
  tracker.update([...candles, next], 90)
  expect(levels(tracker, 2).map(l => l.price)).toEqual([140, 60])
  tracker.update([...candles, next], 91)
  expect(levels(tracker, 2).map(l => l.price)).toEqual([140, 60])
  tracker.update([...candles, next, bar(91)], 92)
  expect(levels(tracker, 2).map(l => l.price)).toEqual([139.5, 140, 60.5, 60])
})

it('repeated equal prices replace taken confirmed origins only after the new right candle closes', () => {
  const candles = [bar(0), bar(1, 110, 90), bar(2), bar(3, 110, 90), bar(4)]
  const tracker = new UntakenLevels()
  tracker.update(candles.slice(0, 3), 3)
  expect(levels(tracker).every(l => l.time === candles[1].time)).toBe(true)
  tracker.update(candles.slice(0, 4), 4)
  expect(levels(tracker)).toEqual([])
  tracker.update(candles, 5)
  expect(levels(tracker).map(l => l.time)).toEqual([candles[3].time, candles[3].time])
})

it('compares exact wick equality rather than using a tolerance', () => {
  const candles = [bar(0), bar(1, 110, 90), bar(2, 110 + 1e-12, 90 - 1e-12), bar(3)]
  const tracker = new UntakenLevels()
  tracker.update(candles, 4)
  expect(levels(tracker).map(l => l.price)).toEqual([candles[2].high, candles[2].low])
})

it('filters strict current price and preserves untaken historical origins', () => {
  const candles = nested(3), tracker = new UntakenLevels()
  tracker.update(candles, 9)
  expect(tracker.visible(139, 1).map(l => l.price)).toEqual([139.5, 61])
  expect(tracker.visible(61, 1).map(l => l.price)).toEqual([139, 60.5])
  const history = Array.from({ length: 2000 }, (_, i) => i === 1 ? bar(i, 110, 90) : bar(i))
  tracker.update(history, history.length, true)
  expect(levels(tracker).map(l => l.time)).toEqual([history[1].time, history[1].time])
})

it('rebuilds replay history without future information', () => {
  const candles = [bar(0), bar(1, 110, 90), bar(2), bar(3, 111, 89), bar(4)]
  const tracker = new UntakenLevels()
  for (const count of [1, 2, 3, 5, 4, 2, 5]) {
    tracker.update(candles.slice(0, count), count, true)
    expect(levels(tracker)).toEqual(expected(candles.slice(0, count), count, 100, 1000))
  }
})

it.each(['smooth', 'plateaus'])('matches an independent confirmed-plateau definition on incremental %s replay', kind => {
  const candles = Array.from({ length: 300 }, (_, i) => {
    const center = 100 + (kind === 'plateaus' ? Math.round(Math.sin(i / 4) * 3) : Math.sin(i * 1.3) * 4)
    return bar(i, center + 1, center - 1, center)
  }), tracker = new UntakenLevels()
  for (const count of [1, 2, 3, 4, 20, 50, 100, 101, 200, 300]) {
    const revealed = candles.slice(0, count), completed = count - 1, price = revealed.at(-1)!.close
    tracker.update(revealed, completed)
    for (const limit of [1, 2, 10]) {
      expect(tracker.visible(price, limit)).toEqual(expected(revealed, completed, price, limit))
    }
  }
})

it('validates settings without introducing additional confirmation toggles', () => {
  for (const count of [1, 10, 10001]) expect(validUntakenSettings({ enabled: false, count })).toBe(true)
  for (const count of [0, -1, 2.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '10', null, undefined])
    expect(validUntakenSettings({ enabled: true, count })).toBe(false)
  expect(validUntakenSettings({ enabled: true, count: 15, pivotStrength: 20 })).toBe(false)
})
