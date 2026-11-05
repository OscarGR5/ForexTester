import type { IChartApi, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, SeriesAttachedParameter, UTCTimestamp } from 'lightweight-charts'
import { TIMEFRAME_MS, type Candle, type Timeframe } from './history'
import { regressionVertices, type RegressionChannel } from './regressionChannel'
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
  private projectedVertices(width: number) {
    if (!this.channel || !this.chart) return []
    const scale = this.chart.timeScale(), period = TIMEFRAME_MS[this.timeframe]
    const spacing = scale.options().barSpacing
    const coordinates = new Map<number, number | null>()
    const xAt = (index: number) => {
      const timestamp = this.source[index].timestamp, bucket = Math.floor(timestamp / period) * period
      // Anchor to the real bucket's library coordinate, including existing
      // indicator whitespace. Fractional positions retain the original M1 time.
      let x = coordinates.get(bucket)
      if (x === undefined) { x = scale.timeToCoordinate(bucket / 1000 as UTCTimestamp); coordinates.set(bucket, x) }
      return x === null ? NaN : x + (timestamp - bucket) / period * spacing
    }
    return regressionVertices(this.channel, xAt, width)
  }
  containsPoint(x: number, y: number): boolean {
    if (!this.channel || !this.chart || !this.series) return false
    const points = this.projectedVertices(this.chart.timeScale().width())
    for (const offset of [this.channel.offset, 0, -this.channel.offset]) {
      let previous: { x: number; y: number } | null = null
      for (const point of points) {
        const at = this.series.priceToCoordinate(this.channel.intercept + this.channel.slope * point.observation + offset)
        if (at === null || !Number.isFinite(point.x) || !Number.isFinite(at)) { previous = null; continue }
        const a = previous ?? { x: point.x, y: at }
        const dx = point.x - a.x, dy = at - a.y, lengthSquared = dx * dx + dy * dy
        const fraction = lengthSquared ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / lengthSquared)) : 0
        if ((x - a.x - fraction * dx) ** 2 + (y - a.y - fraction * dy) ** 2 <= CHANNEL_HIT_TOLERANCE_PX ** 2) return true
        previous = { x: point.x, y: at }
      }
    }
    return false
  }
  private readonly renderer: IPrimitivePaneRenderer = {
    draw: target => target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      if (!this.channel || !this.chart || !this.series) return
      const started = performanceStart()
      const points = this.projectedVertices(mediaSize.width)
      ctx.save()
      ctx.beginPath(); ctx.rect(0, 0, mediaSize.width, mediaSize.height); ctx.clip()
      ctx.setLineDash([])
      for (const boundary of ['upper', 'lower', 'middle'] as const) {
        ctx.strokeStyle = boundary === 'middle' ? '#f2bf62' : '#c99a4d'
        ctx.lineWidth = boundary === 'middle' ? 2 : 1
        ctx.beginPath()
        let first = true
        const offset = boundary === 'upper' ? this.channel.offset : boundary === 'lower' ? -this.channel.offset : 0
        for (const point of points) {
          const y = this.series.priceToCoordinate(this.channel.intercept + this.channel.slope * point.observation + offset)
          if (y === null || !Number.isFinite(point.x)) continue
          if (first) { ctx.moveTo(point.x, y); first = false }
          else ctx.lineTo(point.x, y)
        }
        ctx.stroke()
      }
      ctx.restore()
      performanceEnd('regression.draw', started)
    }),
  }
  private readonly views: IPrimitivePaneView[] = [{ zOrder: () => 'bottom', renderer: () => this.renderer }]
  paneViews() { return this.views }
}
