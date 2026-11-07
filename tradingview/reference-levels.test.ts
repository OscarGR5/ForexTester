import { expect, it } from 'vitest'
import type { ChartCandle } from '../frontend/src/indicators'
import { UntakenLevels } from '../frontend/src/untakenLevels'
import { confirmedReferenceSnapshot, PineHarness, pineSource, type Feeds, type Ray } from './pine-harness'

const DAY = 86400, WEEK = 7 * DAY, BASE = 1704067200
const bar = (time: number, high = 101, low = 99, close = 100): ChartCandle => ({ time: time as ChartCandle['time'], open: close, high, low, close })
const nested = (period: number, start = BASE, high = 140, low = 60) => Array.from({ length: 10 }, (_, i) =>
  i % 3 === 1 ? bar(start + i * period, high - Math.floor(i / 3) * 10, low + Math.floor(i / 3) * 10) : bar(start + i * period))
const values = (rays: Ray[]) => rays.map(r => [r.y1, r.width])
function run(pine: PineHarness, candles: ChartCandle[]) {
  let rays: Ray[] = []
  candles.forEach((candle, i) => { rays = pine.execute(candle, i, candles[i - 1], true, i === candles.length - 1) })
  return rays
}
function feedsAt(time: number): Feeds {
  return { '1D': nested(DAY, time - 9 * DAY), '1W': nested(WEEK, time - 9 * WEEK, 300, -100) }
}

it('requests only the current symbol and offset confirmed native prices with lookahead_on', () => {
  expect(pineSource.match(/request\.security\(syminfo\.tickerid, "1[DW]", confirmedReferences\(\), lookahead = barmerge.lookahead_on\)/g)).toHaveLength(2)
  const nativeBody = pineSource.match(/^confirmedReferences\(\) =>\n((?:(?:    .*|)\n)+)/m)![1]
  expect(nativeBody).not.toMatch(/\b(?:high|low)\b(?!\[)/)
  expect(nativeBody).not.toContain('barstate.')
  expect(nativeBody).toContain('candidateHighTime := time[1]')
  expect(nativeBody).toContain('candidateLowTime := time[1]')
})

it.each([['1D', DAY], ['1W', WEEK]] as const)('matches the unchanged TS tracker on every confirmed %s prefix, including native history before the chart starts', (_tf, period) => {
  const candles = nested(period)
  for (let current = 0; current < candles.length; current++) {
    const tracker = new UntakenLevels(); tracker.update(candles.slice(0, current), current)
    const expected = tracker.visible(100, 1000)
    const [highs, highTimes, lows, lowTimes] = confirmedReferenceSnapshot(candles, current)
    for (const [side, prices, times] of [['high', highs, highTimes], ['low', lows, lowTimes]] as const) {
      expect(prices.map((price, i) => ({ price, time: times[i] / 1000, side }))).toEqual(
        expected.filter(l => l.side === side).sort((a, b) => Number(a.time) - Number(b.time)))
    }
  }
})

it.each([['1D', DAY], ['1W', WEEK]] as const)('hides %s pivots throughout the right period and publishes only after its close', (tf, period) => {
  const candles = [bar(BASE), bar(BASE + period, 110, 90), bar(BASE + 2 * period), bar(BASE + 3 * period)]
  const pine = new PineHarness({ showHighs: false, showLows: false, showDaily: tf === '1D', showWeekly: tf === '1W' }, '1', { [tf]: candles })
  const observed = [bar(BASE + 2 * period), bar(BASE + 3 * period - 60), bar(BASE + 3 * period)]
  expect(pine.execute(observed[0], 0, undefined, true)).toEqual([])
  expect(pine.execute(observed[1], 1, observed[0], true)).toEqual([])
  const rays = pine.execute(observed[2], 2, observed[1], false)
  expect(values(rays)).toEqual([[110, tf === '1D' ? 2 : 3], [90, tf === '1D' ? 2 : 3]])
  expect(rays.every(r => r.x1 === (BASE + period) * 1000)).toBe(true)
})

it.each([2, 3, 8])('retains first-candle anchors of a %i-bar plateau independently in Daily and Weekly contexts', length => {
  for (const period of [DAY, WEEK]) {
    const candles = [bar(BASE), ...Array.from({ length }, (_, i) => bar(BASE + (i + 1) * period, 110, 90)), bar(BASE + (length + 1) * period), bar(BASE + (length + 2) * period)]
    expect(confirmedReferenceSnapshot(candles, length + 1).slice(0, 4)).toEqual([[], [], [], []])
    expect(confirmedReferenceSnapshot(candles, length + 2).slice(0, 4)).toEqual([[110], [(BASE + period) * 1000], [90], [(BASE + period) * 1000]])
  }
})

it.each(['1D', '1W'] as const)('selects the most recent %s origin and falls back immediately through older survivors on live wicks', tf => {
  const period = tf === '1D' ? DAY : WEEK, candles = nested(period), time = BASE + 9 * period
  const pine = new PineHarness({ showHighs: false, showLows: false, showDaily: tf === '1D', showWeekly: tf === '1W' }, '1', { [tf]: candles })
  const width = tf === '1D' ? 2 : 3
  const initial = pine.execute(bar(time), 0, undefined, true)
  expect(values(initial)).toEqual([[120, width], [80, width]])
  expect(initial.every(r => r.x1 === (BASE + 7 * period) * 1000)).toBe(true)
  const previous = bar(time), next = time + 60
  const nearerTaken = pine.execute(bar(next, 125, 75), 1, previous, false)
  expect(values(nearerTaken)).toEqual([[130, width], [70, width]])
  expect(nearerTaken.every(r => r.x1 === (BASE + 4 * period) * 1000)).toBe(true)
  const twoTaken = pine.execute(bar(next, 135, 65), 1, previous, true)
  expect(values(twoTaken)).toEqual([[140, width], [60, width]])
  expect(twoTaken.every(r => r.x1 === (BASE + period) * 1000)).toBe(true)
  expect(values(pine.execute(bar(next + 60), 2, bar(next, 135, 65), false))).toEqual([[140, width], [60, width]])
  expect(pine.execute(bar(next + 60, 140, 60), 2, bar(next, 135, 65), false)).toEqual([])
  expect(pine.requests).toHaveLength(1)
})

it.each(['1D', '1W'] as const)('does not resurrect taken %s levels when a new period replaces the snapshot', tf => {
  const period = tf === '1D' ? DAY : WEEK, time = BASE + 9 * period
  const candles = nested(period)
  candles[9] = bar(time, 135, 65)
  candles.push(bar(time + period))
  const pine = new PineHarness({ showHighs: false, showLows: false, showDaily: tf === '1D', showWeekly: tf === '1W' }, '1', { [tf]: candles })
  const beforeTake = bar(time), taking = bar(time + 60, 135, 65)
  expect(pine.execute(beforeTake, 0, undefined, true).map(r => r.y1)).toEqual([120, 80])
  expect(pine.execute(taking, 1, beforeTake, true).map(r => r.y1)).toEqual([140, 60])
  const nextPeriod = pine.execute(bar(time + period), 2, taking, false)
  expect(nextPeriod.map(r => r.y1)).toEqual([140, 60])
  expect(nextPeriod.every(r => r.x1 === (BASE + period) * 1000)).toBe(true)
  expect(pine.requests).toHaveLength(2)
})

it.each(['1', '240'])('renders normal, Daily and Weekly rays at 1/2/3 px on a %s-minute chart independently of normal caps', timeframe => {
  const time = BASE + 9 * WEEK, interval = Number(timeframe) * 60
  const candles = [bar(time), bar(time + interval, 110, 90), bar(time + 2 * interval)]
  const pine = new PineHarness({ maxHighs: 1, maxLows: 1 }, timeframe, feedsAt(time))
  const rays = run(pine, candles)
  expect(values(rays)).toEqual([[280, 3], [-80, 3], [120, 2], [80, 2], [110, 1], [90, 1]])
  expect(rays).toHaveLength(6)
  expect(pine.requests).toHaveLength(2)
  expect(pine.message).toBe('')
})

it('keeps fixed reference widths/colors when normal width is changed or normal sides are hidden', () => {
  const time = BASE + 9 * WEEK
  const pine = new PineHarness({ showHighs: false, showLows: false, lineWidth: 4, highColor: '#dd0000', lowColor: '#00bb00' }, '1', feedsAt(time))
  const rays = run(pine, [bar(time), bar(time + 60, 110, 90), bar(time + 120)])
  expect(values(rays)).toEqual([[280, 3], [-80, 3], [120, 2], [80, 2]])
  expect(rays.map(r => r.color)).toEqual(['#dd0000', '#00bb00', '#dd0000', '#00bb00'])
  const all = run(new PineHarness({ lineWidth: 4 }, '1', feedsAt(time)), [bar(time), bar(time + 60, 110, 90), bar(time + 120)])
  expect(all.map(r => r.width)).toEqual([3, 3, 2, 2, 4, 4])
})

it('uses confirmed chart state on D1 immediately at the right close and removes overlapping normal rays', () => {
  const time = BASE + 9 * WEEK, pine = new PineHarness({}, '1D', feedsAt(time))
  const candles = [bar(time), bar(time + DAY, 110, 90), bar(time + 2 * DAY)]
  run(pine, candles.slice(0, 2))
  expect(values(pine.execute(candles[2], 2, candles[1], false))).toEqual([[280, 3], [-80, 3]])
  const rays = pine.execute(candles[2], 2, candles[1], true)
  expect(values(rays)).toEqual([[280, 3], [-80, 3], [110, 2], [90, 2]])
  expect(pine.requests.every(r => r.timeframe === '1W')).toBe(true)
})

it('uses confirmed W1 chart state without requests and explicitly disables the lower Daily reference', () => {
  const candles = [bar(BASE), bar(BASE + WEEK, 110, 90), bar(BASE + 2 * WEEK)]
  const weekly = new PineHarness({}, '1W')
  const rays = run(weekly, candles)
  expect(values(rays)).toEqual([[110, 3], [90, 3]])
  expect(weekly.requests).toHaveLength(0)
  expect(weekly.message).toContain('Daily references unavailable above D1.')
})

it('keeps normal levels on charts above W1 and reports both unsupported references instead of sampling lower timeframes', () => {
  const pine = new PineHarness({}, '1M')
  const rays = run(pine, [bar(BASE), bar(BASE + 30 * DAY, 110, 90), bar(BASE + 60 * DAY)])
  expect(values(rays)).toEqual([[110, 1], [90, 1]])
  expect(pine.requests).toHaveLength(0)
  expect(pine.message).toContain('Daily references unavailable')
  expect(pine.message).toContain('Weekly references unavailable')
})

it.each([
  { showDaily: true, showWeekly: true, width: 3, origin: BASE + WEEK },
  { showDaily: true, showWeekly: false, width: 2, origin: BASE + 8 * DAY },
  { showDaily: false, showWeekly: false, width: 1, origin: BASE + 8 * DAY },
])('deduplicates equal prices with Weekly > Daily > normal priority: %j', ({ width, origin, ...settings }) => {
  const daily = Array.from({ length: 22 }, (_, i) => bar(BASE + i * DAY, i === 8 ? 140 : 101, i === 8 ? 60 : 99))
  const weekly = Array.from({ length: 4 }, (_, i) => bar(BASE + i * WEEK, i === 1 ? 140 : 101, i === 1 ? 60 : 99))
  const pine = new PineHarness(settings, '1', { '1D': daily, '1W': weekly })
  const rays = run(pine, [bar(BASE), bar(BASE + 8 * DAY, 140, 60), bar(BASE + 8 * DAY + 60), bar(BASE + 2 * WEEK), bar(BASE + 3 * WEEK)])
  expect(values(rays)).toEqual([[140, width], [60, width]])
  expect(rays.every(r => r.x1 === origin * 1000)).toBe(true)
})

it('does not leak a completed native period into earlier chart candles even when the fixture contains future data', () => {
  const feed = [bar(BASE), bar(BASE + DAY, 110, 90), bar(BASE + 2 * DAY), bar(BASE + 3 * DAY), bar(BASE + 4 * DAY, 999, -999)]
  const pine = new PineHarness({ showWeekly: false, showHighs: false, showLows: false }, '1', { '1D': feed })
  expect(run(pine, [bar(BASE), bar(BASE + DAY), bar(BASE + 2 * DAY)])).toEqual([])
  expect(values(pine.execute(bar(BASE + 3 * DAY), 3, bar(BASE + 2 * DAY), false))).toEqual([[110, 2], [90, 2]])
  const changed = feed.map((c, i) => i >= 3 ? { ...c, high: 10000, low: -10000 } : c)
  expect(confirmedReferenceSnapshot(changed, 3)).toEqual(confirmedReferenceSnapshot(feed, 3))
  expect(pine.requests.every(r => r.lastClosedTime === null || r.lastClosedTime < r.time)).toBe(true)
})

it('waits through an initially partial HTF period rather than inventing its earlier price path', () => {
  const candles = [...nested(DAY), bar(BASE + 10 * DAY)]
  const pine = new PineHarness({ showWeekly: false, showHighs: false, showLows: false }, '1', { '1D': candles })
  const first = bar(BASE + 9 * DAY + 60)
  expect(pine.execute(first, 0, undefined, true)).toEqual([])
  expect(pine.message).toContain('Daily: awaiting a loaded period boundary.')
  expect(values(pine.execute(bar(BASE + 10 * DAY), 1, first, true))).toEqual([[120, 2], [80, 2]])
  expect(pine.message).toBe('')
})

it('keeps empty confirmed histories empty with no candidate rays', () => {
  const time = BASE + 3 * WEEK
  const flat = (period: number) => Array.from({ length: 4 }, (_, i) => bar(time + (i - 3) * period))
  const pine = new PineHarness({}, '1', { '1D': flat(DAY), '1W': flat(WEEK) })
  expect(pine.execute(bar(time), 0, undefined, false)).toEqual([])
  expect(pine.message).toBe('')
})

it('matches historical reconstruction after live ticks, invalidations and repeated period-boundary rollback', () => {
  const feed = nested(DAY), settings = { showHighs: false, showLows: false, showWeekly: false }
  const pine = new PineHarness(settings, '1', { '1D': feed })
  const closed: ChartCandle[] = []
  for (const daily of feed) {
    for (const candle of [bar(Number(daily.time)), bar(Number(daily.time) + DAY - 60, daily.high, daily.low)]) {
      const index = closed.length
      const first = pine.execute(bar(Number(candle.time)), index, closed.at(-1), false)
      expect(pine.execute(bar(Number(candle.time)), index, closed.at(-1), false)).toEqual(first)
      pine.execute(candle, index, closed.at(-1), false)
      const live = pine.execute(candle, index, closed.at(-1), true)
      closed.push(candle)
      const reconstructed = run(new PineHarness(settings, '1', { '1D': feed }), closed)
      expect(live).toEqual(reconstructed)
      expect(new Set(live.map(r => `${r.color}:${r.y1}`)).size).toBe(live.length)
    }
  }
})

it('fits 496 normal rays plus four independent references and redraws 500 IDs under rollback without duplicates', () => {
  const time = BASE + 3 * WEEK
  const daily = [bar(time - 3 * DAY), bar(time - 2 * DAY, 700, -500), bar(time - DAY), bar(time)]
  const weekly = [bar(time - 3 * WEEK), bar(time - 2 * WEEK, 900, -700), bar(time - WEEK), bar(time)]
  const pine = new PineHarness({ maxHighs: 248, maxLows: 248 }, '1', { '1D': daily, '1W': weekly })
  const candles = Array.from({ length: 780 }, (_, i) => i % 3 === 1 ? bar(time + i * 60, 400 - Math.floor(i / 3) * 0.5, -200 + Math.floor(i / 3) * 0.5) : bar(time + i * 60))
  const rays = run(pine, candles)
  expect(rays).toHaveLength(500)
  expect(rays.filter(r => r.width === 1)).toHaveLength(496)
  expect(rays.filter(r => r.width === 2)).toHaveLength(2)
  expect(rays.filter(r => r.width === 3)).toHaveLength(2)
  for (let tick = 0; tick < 3; tick++) {
    const next = pine.execute(bar(time + 780 * 60), 780, candles.at(-1), false)
    expect(next).toHaveLength(500)
    expect(new Set(next.map(r => `${r.color}:${r.y1}`)).size).toBe(500)
  }
  expect(pine.peakLineCount).toBe(500)
})
