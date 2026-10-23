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
