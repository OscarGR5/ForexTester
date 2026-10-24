import { performanceStart, performanceEnd, performanceCount } from './replayPerformance.js'
import type { CandlestickData, IChartApi, ISeriesApi, LogicalRange, MouseEventParams, UTCTimestamp } from 'lightweight-charts'
import { TIMEFRAME_MS, type Timeframe } from './history.js'

export interface UtcRange { from: number; to: number }

// Logical coordinates are local to a chart. Convert them through candle UTC times
// before applying a viewport to a chart with another resolution.
export function logicalToUtc(times: readonly number[], logical: number, stepSeconds: number): number {
  if (times.length === 0) return 0
  if (times.length === 1) return times[0] + logical * stepSeconds
  const left = Math.floor(logical)
  if (left < 0) return times[0] + logical * stepSeconds
  if (left >= times.length - 1) return times[times.length - 1] + (logical - times.length + 1) * stepSeconds
  return times[left] + (times[left + 1] - times[left]) * (logical - left)
}

export function utcToLogical(times: readonly number[], utc: number, stepSeconds: number): number {
  if (times.length === 0) return 0
  if (utc < times[0] || times.length === 1) return (utc - times[0]) / stepSeconds
  const last = times.length - 1
  if (utc >= times[last]) return last + (utc - times[last]) / stepSeconds
  let low = 0
  let high = last
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2)
    if (times[middle] <= utc) low = middle
    else high = middle
  }
  return low + (utc - times[low]) / (times[high] - times[low])
}

interface Entry {
  chart: IChartApi
  series: ISeriesApi<'Candlestick'>
  times: number[]
  byTime: Map<number, CandlestickData<UTCTimestamp>>
  step: number
  projectedBars: number
  setting: boolean
  pending: LogicalRange | null
  crosshair?: { time: number; price: number } | null
  onRange: (range: LogicalRange | null) => void
  onCrosshair: (param: MouseEventParams) => void
}

export class ChartSynchronizer {
  onViewportChange?: () => void
  private entries = new Map<number, Entry>()
  private viewport: UtcRange | null = null
  private applyingRange = false
  private applyingCrosshair = false
  private pointer: { id: number; time: number | null; x?: number; y?: number; pane?: number } | null = null
  private activeId: number | null = null
  private activeUntil = 0

  private following = true

  constructor(private bounds?: UtcRange) {}

  snapshot(): { range: UtcRange | null; following: boolean } {
    return { range: this.viewport ? { ...this.viewport } : null, following: this.following }
  }

  restore(view: { range: UtcRange | null; following: boolean } | null): void {
    if (!view) return
    const width = view.range ? view.range.to - view.range.from : 0
    this.viewport = view.following && view.range && this.bounds
      ? { from: this.bounds.to - width, to: this.bounds.to } : view.range
    this.following = view.following
    for (const id of this.entries.keys()) this.refresh(id)
  }

  // Called after every pane has installed this frame's revealed data.
  advance(bounds?: UtcRange): void {
    const previous = this.bounds
    this.bounds = bounds
    if (this.following && this.viewport && bounds && previous && bounds.to > previous.to) {
      const width = this.viewport.to - this.viewport.from || 3600
      this.viewport = { from: bounds.to - width, to: bounds.to }
    }
    for (const id of this.entries.keys()) this.refresh(id)
    this.refreshCrosshair()
  }

  update(id: number, candles: readonly CandlestickData<UTCTimestamp>[], timeframe: Timeframe,
    applyData: () => number | void, dirty = 0): void {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.setting = true
    // A visible crosshair makes the library hit-test and rebuild every series'
    // coordinates on each update. Clear it within the synchronous batch and
    // restore the current pointer after data/viewport installation, before paint.
    if (this.pointer || entry.crosshair) {
      performanceCount('sync.crosshair.batchClear')
      entry.chart.clearCrosshairPosition()
      entry.crosshair = null
    }
    try {
      if (dirty === 0) { entry.times = []; entry.byTime.clear(); entry.crosshair = undefined }
      for (let index = dirty; index < candles.length; index++) {
        const candle = candles[index]
        entry.times[index] = candle.time
        entry.byTime.set(candle.time, candle)
      }
      entry.step = TIMEFRAME_MS[timeframe] / 1000
      entry.projectedBars = applyData() ?? 0
      if (!this.viewport && entry.times.length > 0) this.initializeViewport(entry)
      // Ordinary replay installs every pane first. advance() applies the new
      // shared UTC viewport once, rather than applying the previous viewport here.
      if (dirty === 0 && this.viewport && entry.times.length > 0) this.applyViewport(entry, this.viewport)
      entry.pending = entry.chart.timeScale().getVisibleLogicalRange()
    } finally {
      entry.setting = false
    }
    if (dirty === 0) this.refreshCrosshair()
  }

  private initializeViewport(entry: Entry): void {
    const last = entry.times[entry.times.length - 1]
    const to = this.bounds?.to ?? last
    // The first populated chart sets the shared UTC horizon. Count observed
    // candles, rather than elapsed time, so weekends do not shrink the view.
    // Keep the full pre-roll installed for indicators and manual navigation.
    const first = entry.times[Math.max(0, entry.times.length - 200)]
    const width = last - first || 199 * entry.step
    this.viewport = { from: to - width, to }
  }

  activate(id: number): void {
    this.activeId = id
    this.activeUntil = Date.now() + 1500
  }

  deactivate(): void {
    this.activeId = null
  }

  refresh(id: number): void {
    const entry = this.entries.get(id)
    if (entry && this.viewport && entry.times.length > 0) this.applyViewport(entry, this.viewport)
  }

  register(id: number, chart: IChartApi, series: ISeriesApi<'Candlestick'>,
    candles: readonly CandlestickData<UTCTimestamp>[], timeframe: Timeframe): () => void {
    const entry: Entry = {
      chart, series, times: candles.map((candle) => candle.time as number),
      byTime: new Map(candles.map((candle) => [candle.time as number, candle])),
      step: TIMEFRAME_MS[timeframe] / 1000, projectedBars: 0, setting: false, pending: null,
      onRange: (range) => this.onRange(id, range),
      onCrosshair: (param) => this.onCrosshair(id, param),
    }
    if (entry.times.length > 0 && !this.viewport) {
      this.initializeViewport(entry)
    }
    this.entries.set(id, entry)
    chart.timeScale().subscribeVisibleLogicalRangeChange(entry.onRange)
    chart.subscribeCrosshairMove(entry.onCrosshair)
    if (this.viewport && candles.length > 0) this.applyViewport(entry, this.viewport)
    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(entry.onRange)
      chart.unsubscribeCrosshairMove(entry.onCrosshair)
      if (this.entries.get(id) === entry) {
        this.entries.delete(id)
        if (this.pointer?.id === id) { this.pointer = null; this.publishCrosshair(id, null) }
      }
    }
  }

  private onRange(id: number, range: LogicalRange | null): void {
    const source = this.entries.get(id)
    if (!source || !range || source.times.length === 0 || this.applyingRange || source.setting) return
    if (source.pending) {
      const pending = source.pending
      source.pending = null
      if (Math.abs(range.from - pending.from) < 0.001 && Math.abs(range.to - pending.to) < 0.001) return
    }
    if (this.activeId !== id || Date.now() > this.activeUntil) return
    const first = this.bounds?.from ?? source.times[0]
    const last = this.bounds?.to ?? source.times[source.times.length - 1]
    const fromUtc = this.bounds && range.from <= 0 ? first : logicalToUtc(source.times, range.from, source.step)
    const toUtc = this.bounds && range.to >= source.times.length - 1 ? last : logicalToUtc(source.times, range.to, source.step)
    const from = Math.max(first, Math.min(last, fromUtc))
    const to = Math.max(first, Math.min(last, toUtc))
    if (from >= to) return
    this.viewport = { from, to }
    this.following = to >= last - source.step
    this.onViewportChange?.()
    this.applyingRange = true
    try {
      for (const [targetId, target] of this.entries) {
        if (targetId !== id && target.times.length > 0) this.applyViewport(target, this.viewport)
      }
    } finally {
      this.applyingRange = false
    }
  }

  private applyViewport(target: Entry, viewport: UtcRange): void {
    const started = performanceStart()
    performanceCount('sync.request')
    const lastIndex = target.times.length - 1
    if (lastIndex === 0) {
      target.chart.timeScale().fitContent()
      return
    }
    const requestedFrom = utcToLogical(target.times, viewport.from, target.step)
    const requestedTo = utcToLogical(target.times, viewport.to, target.step)
    // Keep the requested span while shifting it onto existing candle positions.
    // UTC times inside the final bucket map beyond its opening logical index.
    const width = Math.min(lastIndex, requestedTo - requestedFrom)
    const to = Math.max(width, Math.min(lastIndex, requestedTo))
    const from = to - width
    const projectedTo = to + (viewport.to >= target.times[lastIndex] ? target.projectedBars : 0)
    if (from >= to) return
    const current = target.chart.timeScale().getVisibleLogicalRange()
    if (current && Math.abs(current.from - from) < 0.001 && Math.abs(current.to - projectedTo) < 0.001) return
    target.setting = true
    try {
      performanceCount('sync.setRange')
      target.chart.timeScale().setVisibleLogicalRange({ from, to: projectedTo })
      // The library may clamp the requested range at a history edge. Suppress
      // the range it actually applied when its change callback arrives.
      target.pending = target.chart.timeScale().getVisibleLogicalRange()
    } finally {
      target.setting = false
      performanceEnd('sync.apply', started)
    }
  }

  private onCrosshair(id: number, param: MouseEventParams): void {
    if (this.applyingCrosshair) return
    if (param.sourceEvent) {
      this.pointer = { id, time: typeof param.time === 'number' ? param.time : null, x: param.point?.x, y: param.point?.y, pane: param.paneIndex }
      const source = this.entries.get(id)
      if (source) source.crosshair = undefined
      this.publishCrosshair(id, this.pointer.time)
    } else if (this.pointer?.id === id && !param.point) {
      this.pointer = null
      this.publishCrosshair(id, null)
    }
  }

  private refreshCrosshair(): void {
    const pointer = this.pointer
    if (!pointer) return
    const source = this.entries.get(pointer.id)
    if (!source) { this.pointer = null; return }
    const time = pointer.x === undefined ? pointer.time : source.chart.timeScale().coordinateToTime(pointer.x)
    if (typeof time === 'number' && pointer.y !== undefined) {
      const series = source.chart.panes()[pointer.pane ?? 0]?.getSeries()[0]
      const price = series?.coordinateToPrice(pointer.y)
      if (price !== null && price !== undefined && (source.crosshair?.time !== time || source.crosshair.price !== price)) {
        performanceCount('sync.crosshair.restore')
        source.chart.setCrosshairPosition(price, time as UTCTimestamp, series!)
        source.crosshair = { time, price }
      }
    }
    this.publishCrosshair(pointer.id, typeof time === 'number' ? time : null)
  }

  private publishCrosshair(id: number, utc: number | null): void {
    this.applyingCrosshair = true
    try {
      for (const [targetId, target] of this.entries) {
        if (targetId === id) continue
        const bucket = utc === null ? null : Math.floor(utc / target.step) * target.step
        const candle = bucket === null ? undefined : target.byTime.get(bucket)
        if (candle) {
          if (target.crosshair?.time === candle.time && target.crosshair.price === candle.close) continue
          target.crosshair = { time: candle.time, price: candle.close }
          performanceCount('sync.crosshair.set')
          target.chart.setCrosshairPosition(candle.close, candle.time, target.series)
        } else if (target.crosshair !== null) {
          target.crosshair = null
          performanceCount('sync.crosshair.clear')
          target.chart.clearCrosshairPosition()
        }
      }
    } finally {
      this.applyingCrosshair = false
    }
  }
}
