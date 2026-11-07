import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import type { ChartCandle } from '../frontend/src/indicators'
import { UntakenLevels } from '../frontend/src/untakenLevels'
import { PineHarness, pineSource, type Ray, type Settings } from './pine-harness'

const bar = (i: number, high = 101, low = 99, close = 100): ChartCandle => ({ time: (1704067200 + i * 60) as ChartCandle['time'], open: close, high, low, close })
const pivot = () => [bar(0), bar(1, 110, 90), bar(2)]
const nested = (count: number, plateau = false) => Array.from({ length: count * (plateau ? 4 : 3) }, (_, i) => {
  const width = plateau ? 4 : 3
  return i % width === 1 || plateau && i % width === 2 ? bar(i, 400 - Math.floor(i / width) * 0.5, -200 + Math.floor(i / width) * 0.5) : bar(i)
})
function expected(tracker: UntakenLevels, price: number, settings: Settings) {
  return tracker.visible(price, Math.max(settings.maxHighs, settings.maxLows)).filter(level =>
    level.side === 'high' ? settings.showHighs : settings.showLows)
    .filter((level, i, all) => all.slice(0, i + 1).filter(other => other.side === level.side).length <=
      (level.side === 'high' ? settings.maxHighs : settings.maxLows))
}
function actual(rays: Ray[], settings: Settings) {
  return rays.map(ray => ({ time: ray.x1 / 1000, price: ray.y1, side: ray.color === settings.highColor ? 'high' : 'low' }))
}
class Scenario {
  pine: PineHarness
  tracker = new UntakenLevels()
  closed: ChartCandle[] = []
  rays: Ray[] = []
  constructor(settings: Partial<Settings> = {}) { this.pine = new PineHarness(settings) }
  tick(candle: ChartCandle, confirmed = false) {
    this.tracker.update([...this.closed, candle], this.closed.length + (confirmed ? 1 : 0))
    this.rays = this.pine.execute(candle, this.closed.length, this.closed.at(-1), confirmed)
    expect(actual(this.rays, this.pine.settings)).toEqual(expected(this.tracker, candle.close, this.pine.settings))
    expect(new Set(this.rays.map(ray => `${ray.color}:${ray.y1}`)).size).toBe(this.rays.length)
    for (const ray of this.rays) {
      expect(ray).toMatchObject({ x2: Number(candle.time) * 1000 + 60_000, y2: ray.y1, xloc: 'bar_time', extend: 'right', style: 'solid', width: this.pine.settings.lineWidth })
    }
    if (confirmed) this.closed.push(candle)
    return actual(this.rays, this.pine.settings)
  }
  load(candles: ChartCandle[]) { for (const candle of candles) this.tick(candle, true); return this }
}

it('declares standalone v6 chart settings and bounded drawings without external data or generic pivots', () => {
  expect(pineSource.startsWith('//@version=6\n')).toBe(true)
  expect(pineSource).toContain('overlay = true, max_lines_count = 500, behind_chart = true')
  expect(pineSource.match(/maxval = 250/g)).toHaveLength(2)
  expect(pineSource).not.toMatch(/\b(?:request\.|ta\.pivot|varip\s)/)
  expect(pineSource).not.toMatch(/line\.new\(latest|latestHigh|latestLow/)
  expect(pineSource).toContain('if barstate.isconfirmed')
  expect(new PineHarness().settings).toEqual({ showHighs: true, showLows: true, maxHighs: 10, maxLows: 10, highColor: '#ef5350', lowColor: '#26a69a', lineWidth: 1 })
})

it('matches the documented OHLC fixture and explicit expected origin/price events from ForexTester', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/plateau-events.json', import.meta.url), 'utf8')) as
    { high: number; low: number; close: number; forming: [number, number, 'high' | 'low'][]; expected: [number, number, 'high' | 'low'][] }[]
  const s = new Scenario()
  fixture.forEach((row, i) => {
    const candle = bar(i, row.high, row.low, row.close)
    const events = row.expected.map(([origin, price, side]) => ({ time: bar(origin).time, price, side }))
    expect(s.tick(candle)).toEqual(row.forming.map(([origin, price, side]) => ({ time: bar(origin).time, price, side })))
    expect(s.tick(candle, true)).toEqual(events)
  })
})

it('does not draw growing or pending extremes before right-candle confirmation', () => {
  const s = new Scenario().load([bar(0)])
  s.tick(bar(1, 105, 95)); expect(s.rays).toEqual([])
  s.tick(bar(1, 110, 90)); expect(s.rays).toEqual([])
  s.tick(bar(1, 110, 90), true); expect(s.rays).toEqual([])
  expect(s.pine.state.highPrices).toEqual([])
  s.tick(bar(2)); expect(s.rays).toEqual([])
  expect(s.pine.state.pendingHighTime).toBe(Number(bar(1).time) * 1000)
  s.tick(bar(2), true)
  expect(s.pine.state.highPrices).toEqual([110]); expect(s.pine.state.lowPrices).toEqual([90])
  expect(s.rays.map(r => r.x1)).toEqual([Number(bar(1).time) * 1000, Number(bar(1).time) * 1000])
})

it.each([2, 3, 8])('anchors %i equal candles to their first candle through forming equals and weaker-close confirmation', length => {
  const s = new Scenario().load([bar(0)])
  for (let i = 1; i <= length; i++) {
    s.tick(bar(i, 110, 90)); s.tick(bar(i, 110, 90), true)
    expect(s.rays).toEqual([])
    expect(s.pine.state.highPrices).toEqual([])
  }
  s.tick(bar(length + 1)); expect(s.rays).toEqual([])
  s.tick(bar(length + 1), true); expect(s.pine.state.highPrices).toEqual([110])
  expect(s.rays.map(r => r.x1)).toEqual([Number(bar(1).time) * 1000, Number(bar(1).time) * 1000])
})

it('never draws provisional plateaus or forming breakouts, and confirms the later actual pivot', () => {
  const s = new Scenario().load([bar(0), bar(1, 110, 90)])
  s.tick(bar(2, 105, 95)); s.tick(bar(2, 110, 90))
  expect(s.rays).toEqual([])
  s.tick(bar(2, 111, 89)); s.tick(bar(2, 112, 88)); s.tick(bar(2, 112, 88), true)
  expect(s.rays).toEqual([])
  s.tick(bar(3)); expect(s.rays).toEqual([])
  s.tick(bar(3), true)
  expect(s.rays.map(r => r.x1)).toEqual([Number(bar(2).time) * 1000, Number(bar(2).time) * 1000])
})

it('takes confirmed levels immediately on a forming equal touch without drawing its unconfirmed origin', () => {
  const s = new Scenario().load(pivot())
  s.tick(bar(3, 105, 95)); s.tick(bar(3, 110, 90))
  expect(s.pine.state.highPrices).toEqual([]); expect(s.pine.state.lowPrices).toEqual([])
  expect(s.rays).toEqual([])
  s.tick(bar(3, 111, 89), true)
  expect(s.rays).toEqual([])
})

it('rejects initial equality and plateaus without strictly weaker left wicks', () => {
  new Scenario().load([bar(0, 110, 90), bar(1, 110, 90), bar(2)])
  const s = new Scenario().load([bar(0, 120, 80), bar(1, 110, 90), bar(2, 110, 90), bar(3)])
  expect(s.rays).toEqual([])
})

it('uses independent high/low plateau boundaries and detects smaller local swings', () => {
  new Scenario().load([bar(0, 120, 80), bar(1), bar(2, 102, 98), bar(3)])
  const s = new Scenario().load([bar(0, 106, 95), bar(1, 110, 90), bar(2, 110, 92), bar(3, 110, 91), bar(4, 107, 94)])
  expect(s.rays.map(r => r.y1)).toEqual([110, 91, 90])
})

it('preserves tiny strict differences without introducing a plateau tolerance in the source adapter', () => {
  const s = new Scenario().load([bar(0), bar(1, 110, 90), bar(2, 110 + 1e-12, 90 - 1e-12), bar(3)])
  expect(s.rays.every(r => r.x1 === Number(bar(2).time) * 1000)).toBe(true)
})

it.each([false, true])('keeps hidden levels under nearest-N selection and reveals old anchors after takes (plateau=%s)', plateau => {
  const candles = nested(30, plateau), s = new Scenario({ maxHighs: 1, maxLows: 2 }).load(candles)
  expect(s.rays.map(r => r.y1)).toEqual([385.5, -185.5, -186])
  s.tick(bar(candles.length, 399.5, -199.5))
  expect(s.rays.map(r => r.y1)).toEqual([400, -200])
  expect(s.rays.at(-1)!.x1).toBe(Number(candles[1].time) * 1000)
})

it('ignores unconfirmed latest-bar extremes while filtering confirmed prices', () => {
  const s = new Scenario({ maxHighs: 1, maxLows: 1 }).load(pivot())
  s.tick(bar(3, 105, 95, 105)); expect(s.rays.map(r => r.y1)).toEqual([110, 90])
  s.tick(bar(3, 105, 95, 95)); expect(s.rays.map(r => r.y1)).toEqual([110, 90])
})

it.each([{ showHighs: false }, { showLows: false }, { showHighs: false, showLows: false }])('honors side visibility without discarding tracked data: %j', settings => {
  const s = new Scenario(settings).load(pivot())
  expect(s.pine.state.highPrices).toEqual([110]); expect(s.pine.state.lowPrices).toEqual([90])
})

it('deletes previous drawings before creating 500 rays, including repeated unfinished ticks', () => {
  const pine = new PineHarness({ maxHighs: 250, maxLows: 250, lineWidth: 4 }), candles = nested(260, true)
  for (let i = 0; i < candles.length; i++) pine.execute(candles[i], i, candles[i - 1], true, i === candles.length - 1)
  const tracker = new UntakenLevels(); tracker.update(candles, candles.length)
  const rays = pine.execute(bar(candles.length), candles.length, candles.at(-1), false)
  expect(actual(rays, pine.settings)).toEqual(tracker.visible(100, 250))
  expect(rays).toHaveLength(500)
  for (let i = 0; i < 3; i++) expect(pine.execute(bar(candles.length), candles.length, candles.at(-1), false)).toHaveLength(500)
  expect(pine.peakLineCount).toBe(500)
})

it('reconstructs historical state, preserves anchors older than 10,000 bars, and redraws on reload', () => {
  const candles = Array.from({ length: 10_100 }, (_, i) => i === 1 ? bar(i, 110, 90) : bar(i))
  const load = (pine: PineHarness) => {
    let rays: Ray[] = []
    for (let i = 0; i < candles.length; i++) rays = pine.execute(candles[i], i, candles[i - 1], true, i === candles.length - 1)
    return rays
  }
  const rays = load(new PineHarness())
  expect(rays.map(r => r.x1)).toEqual([Number(bar(1).time) * 1000, Number(bar(1).time) * 1000])
  expect(load(new PineHarness())).toEqual(rays)
})

it('rebuilds backward replay snapshots without observing future bars', () => {
  const candles = [bar(0), bar(1, 110, 90), bar(2, 110, 90), bar(3), bar(4, 111, 89)]
  for (const length of [5, 4, 3, 2, 1, 4]) {
    const s = new Scenario().load(candles.slice(0, length))
    const fresh = new UntakenLevels(); fresh.update(candles.slice(0, length), length)
    expect(actual(s.rays, s.pine.settings)).toEqual(fresh.visible(100, 10))
  }
})

it.each(['smooth', 'plateaus', 'negative'])('matches the real TypeScript tracker on deterministic %s OHLC, every close and multiple intrabar ticks', kind => {
  const s = new Scenario({ maxHighs: 3, maxLows: 5 })
  for (let i = 0; i < 500; i++) {
    const center = (kind === 'negative' ? -100 : 100) + (kind === 'plateaus' ? Math.round(Math.sin(i / 4) * 3) : Math.sin(i * 1.3) * 4)
    s.tick(bar(i, center + 0.25, center - 0.25, center))
    s.tick(bar(i, center + 0.5, center - 0.5, center))
    s.tick(bar(i, center + 1, center - 1, center), true)
  }
})
