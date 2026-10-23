import type { CandlestickData, IChartApi, ISeriesApi, LogicalRange, MouseEventParams, UTCTimestamp } from 'lightweight-charts'
import { TIMEFRAME_MS, type Timeframe } from './history'

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
  onRange: (range: LogicalRange | null) => void
  onCrosshair: (param: MouseEventParams) => void
}

export class ChartSynchronizer {
  private entries = new Map<number, Entry>()
  private viewport: UtcRange | null = null
  private applyingRange = false
  private applyingCrosshair = false
  private activeId: number | null = null
  private activeUntil = 0

  private following = true

  constructor(private bounds?: UtcRange) {}

  // Called after every pane has installed this frame's revealed data.
  advance(bounds?: UtcRange): void {
    const previous = this.bounds
    this.bounds = bounds
    if (this.following && this.viewport && bounds && previous && bounds.to > previous.to) {
      const width = this.viewport.to - this.viewport.from || 3600
      this.viewport = { from: bounds.to - width, to: bounds.to }
    }
    for (const id of this.entries.keys()) this.refresh(id)
  }

  update(id: number, candles: readonly CandlestickData<UTCTimestamp>[], timeframe: Timeframe,
    applyData: () => number | void, dirty = 0): void {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.setting = true
    try {
      if (dirty === 0) { entry.times = []; entry.byTime.clear() }
      for (let index = dirty; index < candles.length; index++) {
        const candle = candles[index]
        entry.times[index] = candle.time
        entry.byTime.set(candle.time, candle)
      }
      entry.step = TIMEFRAME_MS[timeframe] / 1000
      entry.projectedBars = applyData() ?? 0
      if (!this.viewport && entry.times.length > 0) this.initializeViewport(entry)
      if (this.viewport && entry.times.length > 0) this.applyViewport(entry, this.viewport)
      entry.pending = entry.chart.timeScale().getVisibleLogicalRange()
    } finally {
      entry.setting = false
    }
  }

  private initializeViewport(entry: Entry): void {
    entry.chart.timeScale().fitContent()
    const bounds = this.bounds ?? { from: entry.times[0], to: entry.times[entry.times.length - 1] }
    // A single revealed candle starts with a one-hour following window.
    this.viewport = bounds.from === bounds.to ? { from: bounds.from - 3600, to: bounds.to } : bounds
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
      if (this.entries.get(id) === entry) this.entries.delete(id)
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
      target.chart.timeScale().setVisibleLogicalRange({ from, to: projectedTo })
      // The library may clamp the requested range at a history edge. Suppress
      // the range it actually applied when its change callback arrives.
      target.pending = target.chart.timeScale().getVisibleLogicalRange()
    } finally {
      target.setting = false
    }
  }

  private onCrosshair(id: number, param: MouseEventParams): void {
    if (this.applyingCrosshair) return
    this.applyingCrosshair = true
    try {
      for (const [targetId, target] of this.entries) {
        if (targetId === id) continue
        const utc = typeof param.time === 'number' ? param.time : null
        const bucket = utc === null ? null : Math.floor(utc / target.step) * target.step
        const candle = bucket === null ? undefined : target.byTime.get(bucket)
        if (candle) target.chart.setCrosshairPosition(candle.close, candle.time, target.series)
        else target.chart.clearCrosshairPosition()
      }
    } finally {
      this.applyingCrosshair = false
    }
  }
}
