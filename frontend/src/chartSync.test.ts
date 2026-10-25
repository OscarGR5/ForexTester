import { describe, expect, it, vi } from 'vitest'
import type { CandlestickData, IChartApi, ISeriesApi, LogicalRange, MouseEventParams, UTCTimestamp } from 'lightweight-charts'
import { ChartSynchronizer, FOLLOW_RIGHT_OFFSET, logicalToUtc, utcToLogical, validViewportState } from './chartSync'
import { TIMEFRAME_MS, type Timeframe } from './history'
const candles = (times: number[]): CandlestickData<UTCTimestamp>[] => times.map(time => ({ time: time as UTCTimestamp, open: 1, high: 2, low: 0.5, close: 1.5 }))
function fake() {
  let range = { from: 0, to: 10 }, onRange: (r: LogicalRange) => void, crosshair: (p: MouseEventParams) => void
  const priceScale = { applyOptions: vi.fn() }
  const series = { coordinateToPrice: (y: number) => 2 - y / 1000, priceScale: () => priceScale } as unknown as ISeriesApi<'Candlestick'>
  const oscillator = { coordinateToPrice: (y: number) => y }
  const scale = { getVisibleLogicalRange: () => range, fitContent: vi.fn(), coordinateToTime: (x: number) => x,
    setVisibleLogicalRange: vi.fn((r: LogicalRange) => { range = r; onRange?.(r) }),
    subscribeVisibleLogicalRangeChange: (cb: typeof onRange) => { onRange = cb }, unsubscribeVisibleLogicalRangeChange: vi.fn() }
  const chart = { timeScale: () => scale, subscribeCrosshairMove: (cb: typeof crosshair) => { crosshair = cb }, unsubscribeCrosshairMove: vi.fn(),
    setCrosshairPosition: vi.fn(() => crosshair?.({ time: 0 } as MouseEventParams)), clearCrosshairPosition: vi.fn(),
    panes: () => [{ getSeries: () => [series] }, { getSeries: () => [oscillator] }] } as unknown as IChartApi
  return { chart, series, scale, priceScale, oscillator, range: () => range,
    pan: (r: typeof range) => { range = r; onRange(r as LogicalRange) },
    pointer: (time?: number, y = 765.43, paneIndex = 0) => crosshair({ time, point: time === undefined ? undefined : { x: time, y }, paneIndex, sourceEvent: {} } as MouseEventParams) }
}
const times = (length = 100, step = 300) => Array.from({ length }, (_, i) => i * step)
function register(sync: ChartSynchronizer, id: number, f: ReturnType<typeof fake>, tf: Timeframe = 'M5', t = times()) { return sync.register(id, f.chart, f.series, candles(t), tf) }

describe('independent chart navigation', () => {
  it('converts UTC and logical coordinates across gaps and fractional positions', () => {
    expect(logicalToUtc([0, 300, 900], 1.5, 300)).toBe(600)
    expect(utcToLogical([0, 300, 900], 600, 300)).toBe(1.5)
    expect(logicalToUtc([0, 300, 900], -1, 300)).toBe(-300)
    expect(utcToLogical([0, 300, 900], 1200, 300)).toBe(3)
  })
  it.each([1, 2, 3])('keeps zoom and pan local in a %i-chart layout and ignores resize callbacks', count => {
    const sync = new ChartSynchronizer(), charts = Array.from({ length: count }, fake)
    charts.forEach((f, id) => register(sync, id, f))
    const before = charts.map(f => ({ ...f.range() }))
    sync.wheel(0, -100)
    expect(charts[0].range().to).toBe(before[0].to)
    expect(charts[0].range().from).toBeGreaterThan(before[0].from)
    for (let id = 1; id < count; id++) expect(charts[id].range()).toEqual(before[id])
    sync.activate(0); charts[0].pan({ from: 5, to: 20 })
    for (let id = 1; id < count; id++) expect(charts[id].range()).toEqual(before[id])
    const view = sync.snapshot(); sync.deactivate(); charts[0].pan({ from: 0, to: 10 }); expect(sync.snapshot()).toEqual(view)
  })
  it('anchors both zoom directions to the right edge and clamps extremes and nonfinite input', () => {
    const sync = new ChartSynchronizer(), f = fake(); register(sync, 0, f)
    sync.activate(0); f.pan({ from: 20, to: 80 }); sync.wheel(0, -100)
    const zoomed = { ...f.range() }; expect(zoomed.to).toBe(80); expect(zoomed.from).toBeGreaterThan(20)
    sync.wheel(0, 100); expect(f.range().to).toBe(80); expect(f.range().from).toBeCloseTo(20)
    for (let i = 0; i < 20; i++) sync.wheel(0, -10000)
    expect(f.range().to - f.range().from).toBe(5)
    const before = { ...f.range() }; sync.wheel(0, NaN); expect(f.range()).toEqual(before)
    for (let i = 0; i < 20; i++) sync.wheel(0, 10000)
    expect(f.range()).toEqual({ from: -31, to: 80 })
  })
  it('follows only panes still at the replay edge, preserving zoom across market gaps', () => {
    const sync = new ChartSynchronizer(), manual = fake(), follow = fake()
    register(sync, 0, manual); register(sync, 1, follow)
    sync.activate(0); manual.pan({ from: 5, to: 20 }); sync.wheel(1, -100)
    const span = follow.range().to - follow.range().from
    const extended = [...times(), 3 * 86400]
    sync.update(0, candles(extended), 'M5', () => 0, 100); sync.update(1, candles(extended), 'M5', () => 0, 100)
    sync.advance({ from: 0, to: extended.at(-1)! })
    expect(manual.range()).toEqual({ from: 5, to: 20 })
    expect(follow.range().to).toBe(100 + FOLLOW_RIGHT_OFFSET); expect(follow.range().to - follow.range().from).toBeCloseTo(span)
  })
  it('round trips all panes including unmounted ones through JSON and changed replay bounds', () => {
    const sync = new ChartSynchronizer(), a = fake(), b = fake(); register(sync, 0, a); const stop = register(sync, 1, b)
    sync.activate(0); a.pan({ from: 2.5, to: 18.75 }); sync.wheel(1, -200); stop()
    const saved = JSON.parse(JSON.stringify(sync.snapshot())), restored = new ChartSynchronizer({ from: 0, to: 30000 })
    restored.restore(saved); const c = fake(), d = fake(); register(restored, 0, c); register(restored, 1, d)
    expect(c.range()).toEqual(a.range()); expect(d.range()).toEqual(b.range())
    const third = fake(); register(restored, 2, third, 'H4', times(400, 14400)); expect(third.range()).toEqual({ from: 200, to: 399 + FOLLOW_RIGHT_OFFSET })
    expect(validViewportState(saved)).toBe(true)
    expect(validViewportState({ ...saved, charts: { 0: { ...saved.charts[0], logical: { from: 4, to: 1 } } } })).toBe(false)
  })
  it.each([false, true])('restores a legacy shared range with following=%s', following => {
    const sync = new ChartSynchronizer({ from: 0, to: 29700 }); sync.restore({ range: { from: 300, to: 1500 }, following })
    const f = fake(); register(sync, 0, f)
    expect(f.range()).toEqual(following ? { from: 97, to: 101 } : { from: 1, to: 5 })
  })
  it.each(['M1', 'M5', 'M15', 'H1', 'H4', 'D1'] as const)('starts %s with recent observed bars and retains permitted projection', tf => {
    const sync = new ChartSynchronizer(), f = fake(), t = times(400, TIMEFRAME_MS[tf] / 1000)
    register(sync, 0, f, tf, t); expect(f.range()).toEqual({ from: 200, to: 399 + FOLLOW_RIGHT_OFFSET })
    sync.update(0, candles(t), tf, () => 26)
    expect(f.range().to).toBe(425)
    sync.wheel(0, -200); expect(f.range().to).toBe(425)
  })
})

describe('free crosshair synchronization', () => {
  it('uses pointer price across independent scales and higher timeframe buckets, with no loops', () => {
    const sync = new ChartSynchronizer(), m5 = fake(), h1 = fake(), d1 = fake()
    register(sync, 0, m5); register(sync, 1, h1, 'H1', times(10, 3600)); register(sync, 2, d1, 'D1', [0])
    m5.pointer(4500)
    expect(h1.chart.setCrosshairPosition).toHaveBeenLastCalledWith(2 - 765.43 / 1000, 3600, h1.series)
    expect(d1.chart.setCrosshairPosition).toHaveBeenLastCalledWith(2 - 765.43 / 1000, 0, d1.series)
    expect(m5.chart.setCrosshairPosition).not.toHaveBeenCalled(); expect(h1.priceScale.applyOptions).not.toHaveBeenCalled()
    m5.pointer(4500, 765.44); expect(h1.chart.setCrosshairPosition).toHaveBeenLastCalledWith(2 - 765.44 / 1000, 3600, h1.series)
    const calls = vi.mocked(h1.chart.setCrosshairPosition).mock.calls.length; m5.pointer(4500, 765.44)
    expect(h1.chart.setCrosshairPosition).toHaveBeenCalledTimes(calls)
  })
  it('clears missing, gap and unrevealed buckets and pointer exits', () => {
    const sync = new ChartSynchronizer(), source = fake(), target = fake()
    register(sync, 0, source, 'M5', [0, 300, 600, 900]); register(sync, 1, target, 'M5', [0, 600])
    source.pointer(0); source.pointer(300); expect(target.chart.clearCrosshairPosition).toHaveBeenCalled()
    source.pointer(900); expect(target.chart.setCrosshairPosition).toHaveBeenCalledTimes(1)
    source.pointer(600); source.pointer(); expect(target.chart.clearCrosshairPosition).toHaveBeenCalledTimes(2)
  })
  it('restores oscillator pointer price after replay updates and suspends during stop dragging', () => {
    const sync = new ChartSynchronizer(), source = fake(), target = fake(); register(sync, 0, source); register(sync, 1, target)
    source.pointer(300, 43.5, 1); expect(target.chart.setCrosshairPosition).toHaveBeenLastCalledWith(43.5, 300, target.oscillator)
    sync.update(0, candles(times()), 'M5', () => 0, 99); sync.advance()
    expect(source.chart.setCrosshairPosition).toHaveBeenLastCalledWith(43.5, 300, source.oscillator)
    sync.suspendCrosshair(true); const calls = vi.mocked(target.chart.setCrosshairPosition).mock.calls.length
    source.pointer(600); expect(target.chart.setCrosshairPosition).toHaveBeenCalledTimes(calls)
    sync.suspendCrosshair(false); source.pointer(600); expect(target.chart.setCrosshairPosition).toHaveBeenCalledTimes(calls + 1)
  })
})

it('retains an earlier viewport with left whitespace across replay ticks and save/restore', () => {
 const sync = new ChartSynchronizer(), first = fake(), second = fake()
 register(sync,0,first);register(sync,1,second)
 sync.activate(0);first.pan({from:-20,to:79})
 expect(sync.snapshot().charts!['0'].following).toBe(false)
 sync.update(0,candles(times(101)),'M5',()=>0,100)
 sync.update(1,candles(times(101)),'M5',()=>0,100)
 expect(first.range()).toEqual({from:-20,to:79});expect(second.range().to).toBe(112)
 const restored=new ChartSynchronizer();restored.restore(JSON.parse(JSON.stringify(sync.snapshot())))
 const next=fake();register(restored,0,next,'M5',times(101));expect(next.range()).toEqual(first.range())
 sync.activate(0);first.pan({from:13,to:112})
 expect(sync.snapshot().charts!['0'].following).toBe(true)
 sync.update(0,candles(times(102)),'M5',()=>0,101);expect(first.range()).toEqual({from:14,to:113})
})

it('bounds manual future whitespace, keeps it independent and preserves it across ticks and restore', () => {
 const sync = new ChartSynchronizer(), manual = fake(), follow = fake()
 register(sync, 0, manual); register(sync, 1, follow)
 sync.activate(0); manual.pan({from:60,to:159})
 expect(manual.range().from).toBeCloseTo(39.6); expect(manual.range().to).toBeCloseTo(138.6) // at most 40% of the 99-bar window
 expect(sync.snapshot().charts!['0'].following).toBe(false)
 expect(follow.range().to).toBe(111)
 const manualRange = {...manual.range()}
 sync.update(0,candles(times(101)),'M5',()=>0,100)
 sync.update(1,candles(times(101)),'M5',()=>0,100)
 expect(manual.range()).toEqual(manualRange)
 expect(follow.range().to).toBe(112)
 const restored = new ChartSynchronizer(); restored.restore(JSON.parse(JSON.stringify(sync.snapshot())))
 const next = fake(); register(restored,0,next,'M5',times(101)); expect(next.range()).toEqual(manualRange)
 sync.wheel(0,-20)
 expect(manual.range().to).toBeLessThanOrEqual(100 + (manual.range().to-manual.range().from)*0.4)
 // Returning to the follow offset resumes progression; a larger manual margin does not.
 sync.activate(0);manual.pan({from:13,to:112})
 expect(sync.snapshot().charts!['0'].following).toBe(true)
 sync.update(0,candles(times(102)),'M5',()=>0,101)
 expect(manual.range().to).toBe(113)
})
it('caps a wide future margin at 80 bars and does not manufacture crosshair data in that margin', () => {
 const sync = new ChartSynchronizer(), source = fake(), target = fake()
 register(sync,0,source,'M5',times(400)); register(sync,1,target,'M5',times(400))
 sync.activate(0);source.pan({from:350,to:649})
 expect(source.range().to).toBe(479)
 source.pointer(405*300)
 expect(target.chart.setCrosshairPosition).not.toHaveBeenCalled()
 expect(target.chart.clearCrosshairPosition).toHaveBeenCalled()
})

describe('visibility recovery on forward replay observations', () => {
  it.each([1, 2, 3])('recovers only the offscreen pane in a %i-chart workspace without pointer activity', count => {
    const sync = new ChartSynchronizer(), charts = Array.from({ length: count }, fake)
    charts.forEach((f, id) => register(sync, id, f))
    charts.forEach((f, id) => { sync.activate(id); f.pan({ from: 60, to: 105 + id * 10 }) })
    const before = charts.map(f => ({ ...f.range() }))
    sync.deactivate()
    vi.spyOn(Date, 'now').mockReturnValueOnce(Date.now() + 10000)
    charts.forEach((_, id) => sync.update(id, candles(times(105)), 'M5', () => 26, 99, true))
    expect(charts[0].range()).toEqual({ from: 85, to: 130 })
    expect(sync.snapshot().charts!['0'].following).toBe(true)
    for (let id = 1; id < count; id++) {
      expect(charts[id].range()).toEqual(before[id])
      expect(sync.snapshot().charts![id].following).toBe(false)
    }
    sync.update(0, candles(times(106)), 'M5', () => 26, 104, true)
    expect(charts[0].range()).toEqual({ from: 86, to: 131 })
  })
  it('preserves paused manual navigation through refresh, settings and JSON restore', () => {
    const sync = new ChartSynchronizer(), f = fake(); register(sync, 0, f)
    sync.activate(0); f.pan({ from: -40, to: 5 }); sync.deactivate()
    sync.refresh(0); sync.advance({ from: 0, to: 30000 })
    sync.update(0, candles(times()), 'M5', () => 26, 0, false)
    expect(f.range()).toEqual({ from: -40, to: 5 })
    const restored = new ChartSynchronizer(); restored.restore(JSON.parse(JSON.stringify(sync.snapshot())))
    const next = fake(); register(restored, 0, next)
    expect(next.range()).toEqual(f.range())
  })
  it.each(['M5', 'M15', 'H1', 'H4', 'D1'] as const)('recovers an invisible partial %s candle without adding a logical bar', tf => {
    const sync = new ChartSynchronizer(), f = fake(), data = candles(times(100, TIMEFRAME_MS[tf] / 1000))
    register(sync, 0, f, tf, data.map(c => c.time))
    sync.activate(0); f.pan({ from: 40, to: 90 }); sync.deactivate()
    data[99] = { ...data[99], close: 1.6 }
    sync.update(0, data, tf, () => 26, 99, true)
    expect(f.range()).toEqual({ from: 75, to: 125 })
    expect(sync.snapshot().charts!['0'].following).toBe(true)
    const calls = f.scale.setVisibleLogicalRange.mock.calls.length
    sync.update(0, data, tf, () => 26, 99, true)
    sync.advance()
    expect(f.scale.setVisibleLogicalRange).toHaveBeenCalledTimes(calls)
  })
  it.each([1, 10, 100])('keeps the last candle visible during %i-observation batches across a market gap', batch => {
    const sync = new ChartSynchronizer(), f = fake(); register(sync, 0, f)
    sync.activate(0); f.pan({ from: 55, to: 105 }); sync.deactivate()
    for (let length = 100 + batch; length < 1000; length += batch) {
      const data = times(length).map((time, i) => i < 110 ? time : time + 3 * 86400)
      sync.update(0, candles(data), 'M5', () => 26, length - batch - 1, true)
      expect(f.range().from).toBeLessThan(length - 1)
      expect(f.range().to).toBeGreaterThan(length - 1)
      expect(f.range().to - f.range().from).toBe(50)
    }
    expect(f.range().to % 1).toBe(0)
    expect(f.scale.fitContent).not.toHaveBeenCalled()
    expect(f.priceScale.applyOptions).not.toHaveBeenCalled()
  })
  it('does not recover during historical review, then recovers when returning to the live cursor', () => {
    const sync = new ChartSynchronizer(), f = fake(); register(sync, 0, f)
    sync.activate(0); f.pan({ from: 10, to: 60 }); sync.deactivate()
    sync.update(0, candles(times(90)), 'M5', () => 26, 0, false)
    expect(f.range()).toEqual({ from: 10, to: 60 })
    expect(sync.snapshot().charts!['0'].following).toBe(false)
    sync.update(0, candles(times(100)), 'M5', () => 26, 89, true)
    expect(f.range()).toEqual({ from: 75, to: 125 })
  })
  it('recovers from future-side panning and retains extreme zoom with room for the candle body', () => {
    const sync = new ChartSynchronizer(), f = fake(); register(sync, 0, f)
    sync.activate(0); f.pan({ from: 105, to: 110 })
    sync.update(0, candles(times(101)), 'M5', () => 26, 99, true)
    expect(f.range()).toEqual({ from: 98, to: 103 })
    // Delayed library callbacks and a subsequent gesture use the same narrow margin.
    f.pan({ ...f.range() }); f.pan({ ...f.range() })
    expect(sync.snapshot().charts!['0'].following).toBe(true)
    sync.update(0, candles(times(102)), 'M5', () => 26, 100, true)
    expect(f.range()).toEqual({ from: 99, to: 104 })
  })
})

it('recovers on a new observation with unchanged higher-timeframe OHLC, without a data upload', () => {
 const sync = new ChartSynchronizer(), f = fake(); register(sync, 0, f, 'H4')
 sync.activate(0); f.pan({from:10,to:60}); sync.deactivate()
 sync.refresh(0); expect(f.range()).toEqual({from:10,to:60})
 sync.refresh(0,true); expect(f.range()).toEqual({from:61,to:111})
 expect(sync.snapshot().charts!['0'].following).toBe(true)
})

it('holds a visible manual view until the two-bar safety boundary, then restores the normal margin', () => {
 const sync = new ChartSynchronizer(), f = fake(); register(sync,0,f)
 sync.activate(0); f.pan({from:55,to:105}); sync.deactivate()
 sync.onViewportChange=vi.fn()
 const calls=f.scale.setVisibleLogicalRange.mock.calls.length
 for(const count of [101,102,103]) {
  sync.update(0,candles(times(count)),'M5',()=>0,count-2,true)
  expect(f.range()).toEqual({from:55,to:105})
  expect(sync.snapshot().charts!['0'].following).toBe(false)
 }
 expect(f.scale.setVisibleLogicalRange).toHaveBeenCalledTimes(calls)
 sync.update(0,candles(times(104)),'M5',()=>0,102,true)
 expect(f.range()).toEqual({from:65,to:115})
 expect(f.range().to-103).toBe(FOLLOW_RIGHT_OFFSET)
 expect(sync.onViewportChange).toHaveBeenCalledTimes(1)
 expect(sync.snapshot().charts!['0'].following).toBe(true)
})
