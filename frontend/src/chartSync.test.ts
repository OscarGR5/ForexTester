import { describe, expect, it, vi } from 'vitest'
import type { CandlestickData, IChartApi, ISeriesApi, LogicalRange, MouseEventParams, UTCTimestamp } from 'lightweight-charts'
import { ChartSynchronizer, logicalToUtc, utcToLogical } from './chartSync'
import type { Timeframe } from './history'

function candles(times: number[]): CandlestickData<UTCTimestamp>[] {
  return times.map((time) => ({ time: time as UTCTimestamp, open: 1, high: 2, low: 0.5, close: 1.5 }))
}

function fakeChart(initial: LogicalRange = { from: 0, to: 4 } as LogicalRange, maxLogical?: number, minimumSpan = 0) {
  let range = initial
  let onRange: ((range: LogicalRange | null) => void) | undefined
  let onCrosshair: ((param: MouseEventParams) => void) | undefined
  const setVisibleLogicalRange = vi.fn((next: LogicalRange) => {
    if (next.from >= next.to || (maxLogical !== undefined && (next.from < 0 || next.to > maxLogical))) {
      throw new Error('Range exceeds available chart candles')
    }
    range = next.to - next.from < minimumSpan
      ? { from: next.to - minimumSpan, to: next.to } as LogicalRange
      : next
    onRange?.(range)
  })
  const setCrosshairPosition = vi.fn(() => onCrosshair?.({ time: 0 as UTCTimestamp } as MouseEventParams))
  const clearCrosshairPosition = vi.fn()
  const unsubscribeRange = vi.fn(() => { onRange = undefined })
  const unsubscribeCrosshair = vi.fn(() => { onCrosshair = undefined })
  const chart = {
    timeScale: () => ({ getVisibleLogicalRange: () => range, setVisibleLogicalRange,
      fitContent: vi.fn(), subscribeVisibleLogicalRangeChange: (handler: typeof onRange) => { onRange = handler },
      unsubscribeVisibleLogicalRangeChange: unsubscribeRange }),
    subscribeCrosshairMove: (handler: typeof onCrosshair) => { onCrosshair = handler },
    unsubscribeCrosshairMove: unsubscribeCrosshair,
    setCrosshairPosition, clearCrosshairPosition,
  } as unknown as IChartApi
  return { chart, setVisibleLogicalRange, setCrosshairPosition, clearCrosshairPosition,
    unsubscribeRange, unsubscribeCrosshair, getRange: () => range,
    emitRange: (next: LogicalRange) => { range = next; onRange?.(next) },
    emitCrosshair: (time?: number) => onCrosshair?.({ time: time as UTCTimestamp | undefined } as MouseEventParams) }
}

const series = {} as ISeriesApi<'Candlestick'>

function register(sync: ChartSynchronizer, id: number, chart: ReturnType<typeof fakeChart>, times: number[], timeframe: Timeframe) {
  return sync.register(id, chart.chart, series, candles(times), timeframe)
}

describe('UTC chart synchronization', () => {
  it('converts through timestamps, including market gaps and fractional viewport positions', () => {
    expect(logicalToUtc([0, 300, 900], 1.5, 300)).toBe(600)
    expect(utcToLogical([0, 300, 900], 600, 300)).toBe(1.5)
    expect(logicalToUtc([0, 300, 900], -1, 300)).toBe(-300)
    expect(utcToLogical([0, 300, 900], 1200, 300)).toBe(3)
  })

  it('aligns M5 and H1 by UTC period while preventing range feedback', () => {
    const sync = new ChartSynchronizer()
    const m5 = fakeChart({ from: 0, to: 24 } as LogicalRange)
    const h1 = fakeChart()
    const m5Times = Array.from({ length: 25 }, (_, index) => index * 300)
    const stopM5 = register(sync, 0, m5, m5Times, 'M5')
    const stopH1 = register(sync, 1, h1, [0, 3600, 7200], 'H1')
    sync.activate(0)
    m5.emitRange({ from: 6, to: 18 } as LogicalRange)
    expect(h1.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 0.5, to: 1.5 })
    expect(m5.setVisibleLogicalRange).not.toHaveBeenCalled()
    sync.activate(1)
    h1.emitRange({ from: 0.25, to: 1.25 } as LogicalRange)
    expect(m5.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 3, to: 15 })
    expect(m5.setVisibleLogicalRange).toHaveBeenCalledTimes(1)
    stopM5()
    stopH1()
    expect(m5.unsubscribeRange).toHaveBeenCalledTimes(1)
    expect(h1.unsubscribeCrosshair).toHaveBeenCalledTimes(1)
    m5.emitRange({ from: 0, to: 5 } as LogicalRange)
    expect(h1.setVisibleLogicalRange).toHaveBeenCalledTimes(2)
  })

  it('keeps three different resolutions aligned and clears crosshairs where no candle exists', () => {
    const sync = new ChartSynchronizer()
    const m15 = fakeChart({ from: 0, to: 16 } as LogicalRange)
    const h1 = fakeChart()
    const h4 = fakeChart()
    register(sync, 0, m15, Array.from({ length: 17 }, (_, index) => index * 900), 'M15')
    register(sync, 1, h1, [0, 3600, 7200, 10800, 14400], 'H1')
    register(sync, 2, h4, [0, 14400], 'H4')
    sync.activate(0)
    m15.emitRange({ from: 4, to: 12 } as LogicalRange)
    expect(h1.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 1, to: 3 })
    expect(h4.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 0.25, to: 0.75 })
    m15.emitCrosshair(4500)
    expect(h1.setCrosshairPosition).toHaveBeenLastCalledWith(1.5, 3600, series)
    expect(h4.setCrosshairPosition).toHaveBeenLastCalledWith(1.5, 0, series)
    m15.emitCrosshair()
    expect(h1.clearCrosshairPosition).toHaveBeenCalled()
    expect(h4.clearCrosshairPosition).toHaveBeenCalled()
  })

  it('ignores layout and programmatic resize events, then accepts navigation from the newly active chart', () => {
    const sync = new ChartSynchronizer()
    const m15 = fakeChart({ from: 0, to: 16 } as LogicalRange)
    const h4 = fakeChart()
    register(sync, 0, m15, Array.from({ length: 17 }, (_, index) => index * 900), 'M15')
    sync.activate(0)
    m15.emitRange({ from: 4, to: 12 } as LogicalRange)
    sync.deactivate()
    register(sync, 1, h4, [0, 14400], 'H4')
    expect(h4.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 0.25, to: 0.75 })
    h4.emitRange({ from: 0, to: 1 } as LogicalRange)
    expect(m15.setVisibleLogicalRange).not.toHaveBeenCalled()
    sync.activate(1)
    h4.emitRange({ from: 0.2, to: 0.8 } as LogicalRange)
    expect(m15.setVisibleLogicalRange.mock.lastCall![0].from).toBeCloseTo(3.2)
    expect(m15.setVisibleLogicalRange.mock.lastCall![0].to).toBeCloseTo(12.8)
  })

  it('maps the last coarse candle through the final loaded M1 timestamp', () => {
    const sync = new ChartSynchronizer({ from: 0, to: 28740 })
    const m1 = fakeChart({ from: 0, to: 479 } as LogicalRange)
    const h4 = fakeChart({ from: 0, to: 1 } as LogicalRange)
    register(sync, 0, m1, Array.from({ length: 480 }, (_, index) => index * 60), 'M1')
    register(sync, 1, h4, [0, 14400], 'H4')
    sync.activate(1)
    h4.emitRange({ from: 0.5, to: 1 } as LogicalRange)
    expect(m1.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 120, to: 479 })
  })

  it('synchronizes an M1 viewport wholly inside the last H4 candle and back', () => {
    const lastM1 = 23 * 3600 + 59 * 60
    const sync = new ChartSynchronizer({ from: 0, to: lastM1 })
    const m1 = fakeChart({ from: 0, to: 1439 } as LogicalRange, 1439)
    const h4 = fakeChart({ from: 0, to: 5 } as LogicalRange, 5, 1)
    register(sync, 0, m1, Array.from({ length: 1440 }, (_, index) => index * 60), 'M1')
    register(sync, 1, h4, [0, 4, 8, 12, 16, 20].map((hour) => hour * 3600), 'H4')

    const previousCalls = h4.setVisibleLogicalRange.mock.calls.length
    sync.activate(0)
    m1.emitRange({ from: 1320, to: 1439 } as LogicalRange)
    expect(h4.setVisibleLogicalRange).toHaveBeenCalledTimes(previousCalls + 1)
    const applied = h4.setVisibleLogicalRange.mock.lastCall![0]
    expect(applied.from).toBeGreaterThanOrEqual(0)
    expect(applied.from).toBeLessThan(applied.to)
    expect(applied.to).toBe(5)
    expect(h4.getRange()).toEqual({ from: 4, to: 5 })
    expect(m1.setVisibleLogicalRange).not.toHaveBeenCalled()

    sync.activate(1)
    h4.emitRange({ from: 3, to: 5 } as LogicalRange)
    expect(m1.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 720, to: 1439 })
  })

  it('updates H1 and H4 near the data end and preserves that view when a third chart joins', () => {
    const lastM1 = 23 * 3600 + 59 * 60
    const sync = new ChartSynchronizer({ from: 0, to: lastM1 })
    const m1 = fakeChart({ from: 0, to: 1439 } as LogicalRange, 1439)
    const h1 = fakeChart({ from: 0, to: 23 } as LogicalRange, 23)
    const h4 = fakeChart({ from: 0, to: 5 } as LogicalRange, 5, 1)
    register(sync, 0, m1, Array.from({ length: 1440 }, (_, index) => index * 60), 'M1')
    register(sync, 1, h1, Array.from({ length: 24 }, (_, index) => index * 3600), 'H1')
    sync.activate(0)
    m1.emitRange({ from: 1320, to: 1439 } as LogicalRange)
    expect(h1.setVisibleLogicalRange.mock.lastCall![0].to).toBe(23)

    sync.deactivate()
    register(sync, 2, h4, [0, 4, 8, 12, 16, 20].map((hour) => hour * 3600), 'H4')
    expect(h4.setVisibleLogicalRange.mock.lastCall![0].to).toBe(5)
    expect(h4.getRange()).toEqual({ from: 4, to: 5 })
    sync.activate(2)
    h4.emitRange({ from: 3, to: 5 } as LogicalRange)
    expect(m1.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 720, to: 1439 })
    expect(h1.setVisibleLogicalRange.mock.lastCall![0].to).toBe(23)
  })
})

describe('synchronization during replay updates', () => {
  it('moves the revealed bound and following viewport without re-registering or range feedback', () => {
    const sync = new ChartSynchronizer({ from: 0, to: 28740 })
    const m1 = fakeChart({ from: 0, to: 479 } as LogicalRange)
    const h1 = fakeChart()
    const h4 = fakeChart()
    const stopM1 = register(sync, 0, m1, Array.from({ length: 480 }, (_, index) => index * 60), 'M1')
    const stopH1 = register(sync, 1, h1, Array.from({ length: 8 }, (_, index) => index * 3600), 'H1')
    const stopH4 = register(sync, 2, h4, [0, 14400], 'H4')
    sync.activate(0)
    m1.emitRange({ from: 420, to: 479 } as LogicalRange)
    const apply = vi.fn()
    sync.update(0, candles(Array.from({ length: 481 }, (_, index) => index * 60)), 'M1', apply)
    sync.update(1, candles(Array.from({ length: 9 }, (_, index) => index * 3600)), 'H1', apply)
    sync.update(2, candles([0, 14400, 28800]), 'H4', apply)
    sync.advance({ from: 0, to: 28800 })
    expect(apply).toHaveBeenCalledTimes(3)
    expect(m1.getRange()).toEqual({ from: 421, to: 480 })
    expect(h1.getRange().to).toBe(8)
    expect(h4.getRange().to).toBe(2)
    expect(h4.getRange().from).toBeLessThan(2)
    // Only the two deliberate programmatic M1 moves occurred, with no callback loop.
    expect(m1.setVisibleLogicalRange.mock.calls.length).toBeLessThanOrEqual(2)
    expect(m1.unsubscribeRange).not.toHaveBeenCalled()
    stopM1(); stopH1(); stopH4()
    expect(m1.unsubscribeRange).toHaveBeenCalledTimes(1)
    expect(h4.unsubscribeCrosshair).toHaveBeenCalledTimes(1)
  })

  it('keeps an intentionally older viewport as more M1 candles arrive', () => {
    const sync = new ChartSynchronizer({ from: 0, to: 7200 })
    const m1 = fakeChart()
    const m5 = fakeChart()
    register(sync, 0, m1, Array.from({ length: 121 }, (_, index) => index * 60), 'M1')
    register(sync, 1, m5, Array.from({ length: 25 }, (_, index) => index * 300), 'M5')
    sync.activate(0)
    m1.emitRange({ from: 10, to: 40 } as LogicalRange)
    sync.update(0, candles(Array.from({ length: 122 }, (_, index) => index * 60)), 'M1', () => {})
    sync.update(1, candles(Array.from({ length: 25 }, (_, index) => index * 300)), 'M5', () => {})
    sync.advance({ from: 0, to: 7260 })
    expect(m1.getRange()).toEqual({ from: 10, to: 40 })
    expect(m5.getRange()).toEqual({ from: 2, to: 8 })
  })

  it('uses updated partial closes for crosshairs and never maps to an unrevealed bucket', () => {
    const sync = new ChartSynchronizer({ from: 0, to: 120 })
    const m1 = fakeChart()
    const h1 = fakeChart()
    register(sync, 0, m1, [0, 60, 120], 'M1')
    register(sync, 1, h1, [0], 'H1')
    sync.update(1, [{ ...candles([0])[0], high: 3, close: 2.5 }], 'H1', () => {})
    m1.emitCrosshair(120)
    expect(h1.setCrosshairPosition).toHaveBeenLastCalledWith(2.5, 0, series)
    m1.emitCrosshair(3600)
    expect(h1.clearCrosshairPosition).toHaveBeenCalled()
  })

  it('synchronizes M5/H1 as the latest H1 bucket starts and a third chart joins', () => {
    const sync = new ChartSynchronizer({ from: 0, to: 10740 })
    const m5 = fakeChart()
    const h1 = fakeChart()
    const h4 = fakeChart()
    register(sync, 0, m5, Array.from({ length: 36 }, (_, index) => index * 300), 'M5')
    register(sync, 1, h1, [0, 3600, 7200], 'H1')
    sync.activate(0)
    m5.emitRange({ from: 24, to: 35 } as LogicalRange)
    sync.update(0, candles(Array.from({ length: 37 }, (_, index) => index * 300)), 'M5', () => {})
    sync.update(1, candles([0, 3600, 7200, 10800]), 'H1', () => {})
    sync.advance({ from: 0, to: 10800 })
    expect(m5.getRange().to).toBe(36)
    expect(h1.getRange().to).toBe(3)
    sync.deactivate()
    register(sync, 2, h4, [0], 'H4')
    expect(h4.setVisibleLogicalRange).not.toHaveBeenCalled()
    expect(h4.getRange()).toBeDefined()
  })
})

describe('Ichimoku projection synchronization', () => {
  it('reserves forward plot positions without adding prices or changing another chart horizon', () => {
    const sync = new ChartSynchronizer({ from: 0, to: 240 })
    const projected = fakeChart(), plain = fakeChart()
    register(sync, 0, projected, [0, 60, 120, 180, 240], 'M1')
    register(sync, 1, plain, [0, 60, 120, 180, 240], 'M1')
    sync.update(0, candles([0, 60, 120, 180, 240]), 'M1', () => 2)
    sync.update(1, candles([0, 60, 120, 180, 240]), 'M1', () => 0)
    expect(projected.getRange()).toEqual({ from: 0, to: 6 })
    expect(plain.getRange()).toEqual({ from: 0, to: 4 })
    projected.emitCrosshair(300)
    expect(plain.clearCrosshairPosition).toHaveBeenCalled()
    expect(plain.setCrosshairPosition).not.toHaveBeenCalled()
    sync.update(0, candles([0, 60, 120, 180, 240]), 'M1', () => 0)
    expect(projected.getRange()).toEqual({ from: 0, to: 4 })
  })
})

it('restores a saved horizontal zoom and following preference using public chart APIs', () => {
  const times = Array.from({ length: 13 }, (_, i) => i * 60)
  const original = new ChartSynchronizer({ from: 0, to: 720 }), first = fakeChart()
  register(original, 0, first, times, 'M1')
  original.activate(0); first.emitRange({ from: 2, to: 6 } as LogicalRange)
  const saved = original.snapshot()
  expect(saved).toEqual({ range: { from: 120, to: 360 }, following: false })
  const restored = new ChartSynchronizer({ from: 0, to: 720 }), second = fakeChart()
  restored.restore(saved); register(restored, 0, second, times, 'M1')
  expect(second.getRange()).toEqual({ from: 2, to: 6 })
  restored.advance({ from: 0, to: 780 })
  expect(restored.snapshot()).toEqual(saved)
})

it('aligns a following viewport with the recovered replay edge when UI storage lags the disk checkpoint', () => {
  const sync = new ChartSynchronizer({ from: 0, to: 1200 }), chart = fakeChart()
  sync.restore({ range: { from: 120, to: 360 }, following: true })
  register(sync, 0, chart, Array.from({ length: 21 }, (_, i) => i * 60), 'M1')
  expect(sync.snapshot()).toEqual({ range: { from: 960, to: 1200 }, following: true })
  expect(chart.getRange()).toEqual({ from: 16, to: 20 })
})
