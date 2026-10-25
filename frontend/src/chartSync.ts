import { performanceStart, performanceEnd, performanceCount } from './replayPerformance.js'
import type { CandlestickData, IChartApi, ISeriesApi, LogicalRange, MouseEventParams, UTCTimestamp } from 'lightweight-charts'
import { TIMEFRAME_MS, type Timeframe } from './history.js'

// Logical bars, never market observations. Ichimoku projection can need more.
export const FOLLOW_RIGHT_OFFSET = 12
const MAX_RIGHT_OFFSET = 80
const followOffset = (entry: Entry) => Math.max(FOLLOW_RIGHT_OFFSET, entry.projectedBars)
const maxRightOffset = (entry: Entry, width: number) => Math.max(followOffset(entry), Math.min(MAX_RIGHT_OFFSET, width * 0.4))

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

export interface ChartView {
  range: UtcRange | null
  following: boolean
  logical?: { from: number; to: number }
  step?: number
}
// The top-level fields are the legacy fallback. New saves include each pane.
export interface ViewportState extends ChartView { charts?: Record<string, ChartView> }
export function validViewportState(value: unknown): value is ViewportState {
  const valid = (v: unknown): v is ChartView => {
    const view = v as ChartView
    const range = (r: UtcRange | null) => r === null || !!r && Number.isFinite(r.from) && Number.isFinite(r.to) && r.from < r.to
    return !!view && typeof view.following === 'boolean' && range(view.range) &&
      (view.logical === undefined || view.logical !== null && range(view.logical)) &&
      (view.step === undefined || Number.isFinite(view.step) && view.step > 0)
  }
  if (!valid(value)) return false
  const charts = (value as ViewportState).charts
  return charts === undefined || !!charts && !Array.isArray(charts) && typeof charts === 'object' &&
    Object.entries(charts).every(([id, view]) => /^[0-2]$/.test(id) && valid(view))
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
  onActiveChartChange?: (id: number) => void
  keyboardChartId = 0
  private entries = new Map<number, Entry>()
  private views = new Map<number, ChartView>()
  private legacy: ChartView | null = null
  private applyingCrosshair = false
  private suspended = false
  private pointer: { id: number; time: number | null; x?: number; y?: number; pane?: number } | null = null
  private activeId: number | null = null
  private activeUntil = 0
  constructor(private bounds?: UtcRange) {}

  snapshot(): ViewportState {
    const first = this.views.get(0) ?? this.legacy ?? { range: null, following: true }
    return structuredClone({ range: first.range, following: first.following, charts: Object.fromEntries(this.views) })
  }
  restore(view: ViewportState | null): void {
    if (!view || !validViewportState(view)) return
    this.legacy = view.charts === undefined ? { range: view.range, following: view.following } : null
    this.views = new Map(Object.entries(view.charts ?? {}).map(([id, state]) => [Number(id), structuredClone(state)]))
    for (const id of this.entries.keys()) this.refresh(id)
  }
  advance(bounds?: UtcRange): void {
    this.bounds = bounds
    for (const id of this.entries.keys()) this.refresh(id)
    this.refreshCrosshair()
  }
  update(id: number, candles: readonly CandlestickData<UTCTimestamp>[], timeframe: Timeframe,
    applyData: () => number | void, dirty = 0): void {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.setting = true
    if (this.pointer || entry.crosshair) {
      performanceCount('sync.crosshair.batchClear')
      this.applyingCrosshair = true
      try { entry.chart.clearCrosshairPosition(); entry.crosshair = null } finally { this.applyingCrosshair = false }
    }
    try {
      if (dirty === 0) { entry.times = []; entry.byTime.clear(); entry.crosshair = undefined }
      for (let index = dirty; index < candles.length; index++) {
        const candle = candles[index]
        entry.times[index] = candle.time; entry.byTime.set(candle.time, candle)
      }
      entry.step = TIMEFRAME_MS[timeframe] / 1000
      entry.projectedBars = applyData() ?? 0
      this.ensureView(id, entry)
      this.applyViewport(id, entry)
      entry.pending = entry.chart.timeScale().getVisibleLogicalRange()
    } finally { entry.setting = false }
    if (dirty === 0) this.refreshCrosshair()
  }
  private ensureView(id: number, entry: Entry): void {
    if (this.views.has(id) || !entry.times.length) return
    if (this.legacy?.range) { this.views.set(id, structuredClone(this.legacy)); return }
    const last = entry.times.length - 1
    const from = Math.max(0, last - 199), to = Math.max(1, last + followOffset(entry))
    this.views.set(id, { range: { from: logicalToUtc(entry.times, from, entry.step), to: logicalToUtc(entry.times, to, entry.step) },
      logical: { from, to }, step: entry.step, following: true })
  }
  activate(id: number): void {
    this.activeId = id; this.activeUntil = Date.now() + 1500
    if (this.keyboardChartId !== id) { this.keyboardChartId = id; this.onActiveChartChange?.(id) }
  }
  retainCharts(count: number): void {
    if (this.keyboardChartId >= count) this.activate(0)
  }
  deactivate(): void { this.activeId = null }
  refresh(id: number): void {
    const entry = this.entries.get(id)
    if (entry) { this.ensureView(id, entry); this.applyViewport(id, entry) }
  }
  register(id: number, chart: IChartApi, series: ISeriesApi<'Candlestick'>,
    candles: readonly CandlestickData<UTCTimestamp>[], timeframe: Timeframe): () => void {
    const entry: Entry = {
      chart, series, times: candles.map(c => c.time as number), byTime: new Map(candles.map(c => [c.time as number, c])),
      step: TIMEFRAME_MS[timeframe] / 1000, projectedBars: 0, setting: false, pending: null,
      onRange: range => this.onRange(id, range), onCrosshair: param => this.onCrosshair(id, param),
    }
    this.entries.set(id, entry)
    chart.timeScale().subscribeVisibleLogicalRangeChange(entry.onRange)
    chart.subscribeCrosshairMove(entry.onCrosshair)
    this.refresh(id)
    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(entry.onRange); chart.unsubscribeCrosshairMove(entry.onCrosshair)
      if (this.entries.get(id) === entry) {
        this.entries.delete(id)
        if (this.pointer?.id === id) { this.pointer = null; this.publishCrosshair(id, null, null) }
      }
    }
  }
  private recordRange(id: number, entry: Entry, range: { from: number; to: number }): void {
    this.views.set(id, { range: { from: logicalToUtc(entry.times, range.from, entry.step), to: logicalToUtc(entry.times, range.to, entry.step) },
      logical: { ...range }, step: entry.step, following: Math.abs(range.to - (entry.times.length - 1 + followOffset(entry))) < 0.5 })
  }
  private onRange(id: number, range: LogicalRange | null): void {
    const entry = this.entries.get(id)
    if (!entry || !range || !entry.times.length || entry.setting) return
    if (entry.pending) {
      const pending = entry.pending; entry.pending = null
      if (Math.abs(range.from - pending.from) < 0.001 && Math.abs(range.to - pending.to) < 0.001) return
    }
    if (this.activeId !== id || Date.now() > this.activeUntil) return
    const width = range.to - range.from
    const to = Math.min(range.to, entry.times.length - 1 + maxRightOffset(entry, width))
    const bounded = { from: to - width, to }
    if (to !== range.to) {
      entry.setting = true
      try { entry.chart.timeScale().setVisibleLogicalRange(bounded); entry.pending = entry.chart.timeScale().getVisibleLogicalRange() }
      finally { entry.setting = false }
    }
    this.recordRange(id, entry, bounded); this.onViewportChange?.()
  }
  // Public time-scale API: the right logical edge never depends on pointer X.
  wheel(id: number, delta: number): void {
    const entry = this.entries.get(id), range = entry?.chart.timeScale().getVisibleLogicalRange()
    if (!entry || !range || !Number.isFinite(delta) || !delta || entry.times.length < 2) return
    const available = entry.times.length - 1 + followOffset(entry)
    const width = Math.max(Math.min(5, available), Math.min(available, (range.to - range.from) * Math.exp(Math.max(-1, Math.min(1, delta * 0.002)))))
    const to = Math.min(entry.times.length - 1 + maxRightOffset(entry, width), range.to), next = { from: to - width, to }
    this.activate(id); entry.setting = true
    try { entry.chart.timeScale().setVisibleLogicalRange(next); entry.pending = entry.chart.timeScale().getVisibleLogicalRange() }
    finally { entry.setting = false }
    this.recordRange(id, entry, entry.pending ?? next); this.onViewportChange?.(); this.refreshCrosshair()
  }
  private applyViewport(id: number, entry: Entry): void {
    const view = this.views.get(id), last = entry.times.length - 1
    if (!view?.range || last < 0) return
    if (last === 0 && !entry.projectedBars) { entry.chart.timeScale().fitContent(); return }
    const started = performanceStart(); performanceCount('sync.request')
    const sameStep = view.step === entry.step && view.logical
    const width = Math.max(1, Math.min(last + followOffset(entry),
      sameStep ? view.logical!.to - view.logical!.from : utcToLogical(entry.times, view.range.to, entry.step) - utcToLogical(entry.times, view.range.from, entry.step)))
    const to = view.following ? last + followOffset(entry) : Math.max(Math.min(5, width), Math.min(last + maxRightOffset(entry, width),
      sameStep ? view.logical!.to : utcToLogical(entry.times, view.range.to, entry.step)))
    const next = { from: to - width, to }
    const current = entry.chart.timeScale().getVisibleLogicalRange()
    if (!current || Math.abs(current.from - next.from) > 0.001 || Math.abs(current.to - next.to) > 0.001) {
      const setting = entry.setting; entry.setting = true
      try {
        performanceCount('sync.setRange'); entry.chart.timeScale().setVisibleLogicalRange(next)
        entry.pending = entry.chart.timeScale().getVisibleLogicalRange()
      } finally { entry.setting = setting }
    }
    const following = view.following
    this.recordRange(id, entry, next); this.views.get(id)!.following = following
    performanceEnd('sync.apply', started)
  }
  suspendCrosshair(suspended: boolean): void {
    this.suspended = suspended; this.pointer = null
    this.applyingCrosshair = true
    try { for (const entry of this.entries.values()) { entry.chart.clearCrosshairPosition(); entry.crosshair = null } }
    finally { this.applyingCrosshair = false }
  }
  private onCrosshair(id: number, param: MouseEventParams): void {
    if (this.applyingCrosshair || this.suspended) return
    if (param.sourceEvent) {
      this.pointer = { id, time: typeof param.time === 'number' ? param.time : null, x: param.point?.x, y: param.point?.y, pane: param.paneIndex }
      const source = this.entries.get(id)
      if (source) source.crosshair = undefined
      const price = this.pointerPrice()
      this.publishCrosshair(id, this.pointer.time, price)
    } else if (this.pointer?.id === id && !param.point) {
      this.pointer = null; this.publishCrosshair(id, null, null)
    }
  }
  private pointerPrice(): number | null {
    const p = this.pointer, source = p && this.entries.get(p.id)
    if (!p || !source || p.y === undefined) return null
    const series = (p.pane ?? 0) === 0 ? source.series : source.chart.panes()[p.pane!]?.getSeries()[0]
    return series?.coordinateToPrice(p.y) ?? null
  }
  private refreshCrosshair(): void {
    const p = this.pointer
    if (!p || this.suspended) return
    const source = this.entries.get(p.id)
    if (!source) { this.pointer = null; return }
    const time = p.x === undefined ? p.time : source.chart.timeScale().coordinateToTime(p.x)
    const price = this.pointerPrice()
    this.applyingCrosshair = true
    try {
      if (typeof time === 'number' && price !== null) {
        const series = (p.pane ?? 0) === 0 ? source.series : source.chart.panes()[p.pane!]?.getSeries()[0]
        if (series) { source.chart.setCrosshairPosition(price, time as UTCTimestamp, series); source.crosshair = { time, price } }
      }
    } finally { this.applyingCrosshair = false }
    this.publishCrosshair(p.id, typeof time === 'number' ? time : null, price)
  }
  private publishCrosshair(id: number, utc: number | null, price: number | null): void {
    this.applyingCrosshair = true
    try {
      for (const [targetId, target] of this.entries) {
        if (targetId === id) continue
        const bucket = utc === null ? null : Math.floor(utc / target.step) * target.step
        const candle = bucket === null ? undefined : target.byTime.get(bucket)
        const pane = this.pointer?.pane ?? 0
        const series = pane === 0 ? target.series : target.chart.panes()[pane]?.getSeries()[0]
        if (candle && series && price !== null && Number.isFinite(price)) {
          if (target.crosshair?.time === candle.time && target.crosshair.price === price) continue
          target.crosshair = { time: candle.time, price }; performanceCount('sync.crosshair.set')
          target.chart.setCrosshairPosition(price, candle.time, series)
        } else if (target.crosshair !== null) {
          target.crosshair = null; performanceCount('sync.crosshair.clear'); target.chart.clearCrosshairPosition()
        }
      }
    } finally { this.applyingCrosshair = false }
  }
}
