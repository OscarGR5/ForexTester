import type { IChartApi, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, SeriesAttachedParameter, UTCTimestamp } from 'lightweight-charts'
import { TIMEFRAME_MS, type Candle, type Timeframe } from './history'
import type { RegressionChannel } from './regressionChannel'
import { performanceEnd, performanceStart } from './replayPerformance'

const CHANNEL_HIT_TOLERANCE_PX = 5

export class RegressionChannelPrimitive implements ISeriesPrimitive {
  private chart: IChartApi | null = null
  private series: ISeriesApi<'Candlestick'> | null = null
  private requestUpdate?: () => void
  private channel: RegressionChannel | null = null
  private source: readonly Candle[] = []
  private timeframe: Timeframe = 'M1'
  attached({ chart, series, requestUpdate }: SeriesAttachedParameter) {
    this.chart = chart; this.series = series as ISeriesApi<'Candlestick'>; this.requestUpdate = requestUpdate
  }
  detached() { this.chart = null; this.series = null; this.requestUpdate = undefined }
  update(channel: RegressionChannel | null, source: readonly Candle[], timeframe: Timeframe) {
    this.channel = channel; this.source = source; this.timeframe = timeframe; this.requestUpdate?.()
  }
  private projectedSegments() {
    if (!this.channel || !this.chart || !this.series) return []
    const scale = this.chart.timeScale(), period = TIMEFRAME_MS[this.timeframe]
    const spacing = scale.options().barSpacing
    const xAt = (index: number) => {
      const timestamp = this.source[index].timestamp, bucket = Math.floor(timestamp / period) * period
      // Use the real chart slot, including indicator whitespace, then retain
      // the endpoint's fractional M1 position within that timeframe bucket.
      const x = scale.timeToCoordinate(bucket / 1000 as UTCTimestamp)
      return x === null ? NaN : x + (timestamp - bucket) / period * spacing
    }
    const startX = xAt(this.channel.startIndex), endX = xAt(this.channel.endIndex)
    if (!Number.isFinite(startX) || !Number.isFinite(endX)) return []
    const segments = []
    for (const boundary of ['upper', 'lower', 'middle'] as const) {
      const offset = boundary === 'upper' ? this.channel.offset : boundary === 'lower' ? -this.channel.offset : 0
      const startY = this.series.priceToCoordinate(this.channel.intercept + offset)
      const endY = this.series.priceToCoordinate(this.channel.intercept + this.channel.slope * (this.channel.count - 1) + offset)
      if (startY === null || endY === null || !Number.isFinite(startY) || !Number.isFinite(endY)) continue
      // Intermediate M1 observations need not be evenly spaced on this axis.
      // Connect only the original fit endpoints, in both drawing and hit-testing.
      segments.push({ boundary, start: { x: startX, y: startY }, end: { x: endX, y: endY } })
    }
    return segments
  }
  containsPoint(x: number, y: number): boolean {
    for (const { start: a, end: b } of this.projectedSegments()) {
      const dx = b.x - a.x, dy = b.y - a.y, lengthSquared = dx * dx + dy * dy
      const fraction = lengthSquared ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / lengthSquared)) : 0
      if ((x - a.x - fraction * dx) ** 2 + (y - a.y - fraction * dy) ** 2 <= CHANNEL_HIT_TOLERANCE_PX ** 2) return true
    }
    return false
  }
  private readonly renderer: IPrimitivePaneRenderer = {
    draw: target => target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      if (!this.channel || !this.chart || !this.series) return
      const started = performanceStart()
      const segments = this.projectedSegments()
      ctx.save()
      ctx.beginPath(); ctx.rect(0, 0, mediaSize.width, mediaSize.height); ctx.clip()
      ctx.setLineDash([])
      for (const { boundary, start, end } of segments) {
        ctx.strokeStyle = boundary === 'middle' ? '#f2bf62' : '#c99a4d'
        ctx.lineWidth = boundary === 'middle' ? 2 : 1
        ctx.beginPath()
        ctx.moveTo(start.x, start.y)
        ctx.lineTo(end.x, end.y)
        ctx.stroke()
      }
      ctx.restore()
      performanceEnd('regression.draw', started)
    }),
  }
  private readonly views: IPrimitivePaneView[] = [{ zOrder: () => 'bottom', renderer: () => this.renderer }]
  paneViews() { return this.views }
}
