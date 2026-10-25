import { LineStyle, type IPriceLine, type IPrimitivePaneRenderer, type IPrimitivePaneView, type ISeriesApi, type ISeriesPrimitive, type SeriesAttachedParameter } from 'lightweight-charts'
import { STOP_COLOR, type StopOverlay } from './stopOverlays'

// At most two labels. Keep full rows apart and connect displaced rows to their
// exact price. The library continues to own price-axis values and line hits.
export function stopLabelRows(stops: readonly StopOverlay[], coordinate: (price: number) => number | null, height: number) {
  const half = 11, gap = 25
  const rows = stops.flatMap(stop => {
    const y = coordinate(stop.price)
    return y !== null && y >= 0 && y <= height ? [{ stop, y, center: Math.max(half, Math.min(height - half, y)) }] : []
  }).sort((a, b) => a.y - b.y || a.stop.number - b.stop.number)
  for (let i = 1; i < rows.length; i++) rows[i].center = Math.max(rows[i].center, rows[i - 1].center + gap)
  if (rows.length && rows.at(-1)!.center > height - half) {
    rows.at(-1)!.center = height - half
    for (let i = rows.length - 2; i >= 0; i--) rows[i].center = Math.min(rows[i].center, rows[i + 1].center - gap)
  }
  return rows
}

export class StopLabels implements ISeriesPrimitive {
  private series: ISeriesApi<'Candlestick'> | null = null
  private requestUpdate: (() => void) | null = null
  private stops: readonly StopOverlay[] = []
  private readonly renderer: IPrimitivePaneRenderer = {
    draw: target => target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      if (!this.series) return
      context.save()
      context.font = '12px Inter, system-ui, sans-serif'
      context.textBaseline = 'middle'
      for (const { stop, y, center } of stopLabelRows(this.stops, price => this.series!.priceToCoordinate(price), mediaSize.height)) {
        const width = Math.min(mediaSize.width - 24, context.measureText(stop.label).width + 16)
        const x = mediaSize.width - width - 12
        context.strokeStyle = STOP_COLOR
        context.lineWidth = 1
        context.beginPath(); context.moveTo(x - 6, y); context.lineTo(x - 6, center); context.lineTo(x, center); context.stroke()
        context.fillStyle = '#171e28'
        context.fillRect(x, center - 11, width, 22)
        context.fillStyle = STOP_COLOR
        context.fillText(stop.label, x + 8, center, width - 16)
      }
      context.restore()
    }),
  }
  private readonly views: IPrimitivePaneView[] = [{ zOrder: () => 'top', renderer: () => this.renderer }]
  attached({ series, requestUpdate }: SeriesAttachedParameter) { this.series = series as ISeriesApi<'Candlestick'>; this.requestUpdate = requestUpdate }
  detached() { this.series = null; this.requestUpdate = null }
  setData(stops: readonly StopOverlay[]) { this.stops = stops; this.requestUpdate?.() }
  paneViews() { return this.views }
}

export class StopLines {
  private readonly lines = new Map<string, IPriceLine>()
  private readonly labels = new StopLabels()
  constructor(private readonly series: ISeriesApi<'Candlestick'>) { series.attachPrimitive(this.labels) }
  update(stops: readonly StopOverlay[]) {
    const ids = new Set(stops.map(stop => stop.id))
    for (const [id, line] of this.lines) {
      if (!ids.has(id)) { this.series.removePriceLine(line); this.lines.delete(id) }
    }
    for (const stop of stops) {
      const options = { price: stop.price, color: STOP_COLOR, lineWidth: 1 as const,
        lineStyle: stop.pending ? LineStyle.Dashed : LineStyle.Solid, axisLabelVisible: true, title: '' }
      const line = this.lines.get(stop.id)
      if (line) line.applyOptions(options)
      else this.lines.set(stop.id, this.series.createPriceLine(options))
    }
    this.labels.setData(stops)
  }
  dispose() {
    for (const line of this.lines.values()) this.series.removePriceLine(line)
    this.lines.clear()
    this.series.detachPrimitive(this.labels)
  }
}
