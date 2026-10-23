import { performanceStart, performanceEnd, performanceCount } from './replayPerformance.js'
import type { IChartApi, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, SeriesAttachedParameter } from 'lightweight-charts'
import type { CloudPoint } from './indicators'

export const CLOUD_COLORS = { bullish: 'rgba(76, 86, 106, 0.35)', bearish: 'rgba(178, 181, 190, 0.28)' }
export interface CloudVertex { x: number; a: number; b: number }
export interface CloudPolygon { bullish: boolean; vertices: { x: number; y: number }[] }
// Split each strip at the exact linear intersection, avoiding crossed polygons
// and incorrect color on the other side of an A/B crossover.
export function cloudPolygons(left: CloudVertex, right: CloudVertex): CloudPolygon[] {
  const polygon = (l: CloudVertex, r: CloudVertex, bullish: boolean): CloudPolygon => ({ bullish, vertices: [
    { x: l.x, y: l.a }, { x: r.x, y: r.a }, { x: r.x, y: r.b }, { x: l.x, y: l.b },
  ] })
  const dl = left.a - left.b, dr = right.a - right.b
  if (dl * dr < 0) {
    const t = dl / (dl - dr)
    const cross = { x: left.x + t * (right.x - left.x), a: left.a + t * (right.a - left.a), b: left.b + t * (right.b - left.b) }
    return [polygon(left, cross, dl <= 0), polygon(cross, right, dr <= 0)]
  }
  // Vertices contain screen y coordinates: a higher price has a smaller y.
  return [polygon(left, right, dl === 0 ? dr <= 0 : dl <= 0)]
}

export class IchimokuCloudPrimitive implements ISeriesPrimitive {
  private chart: IChartApi | null = null
  private series: ISeriesApi<'Line'> | null = null
  private requestUpdate: (() => void) | null = null
  private points: CloudPoint[] = []
  private readonly renderer: IPrimitivePaneRenderer = {
    draw: (target) => target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      if (!this.chart || !this.series) return
      const drawing = performanceStart()
      const scale = this.chart.timeScale()
      context.save()
      context.beginPath(); context.rect(0, 0, mediaSize.width, mediaSize.height); context.clip()
      let previous: CloudVertex | null = null
      const visible = scale.getVisibleRange?.()
      let low = 0, high = this.points.length
      if (visible && typeof visible.from === 'number') {
        while (low < high) { const middle = (low + high) >>> 1; if (this.points[middle].time < visible.from) low = middle + 1; else high = middle }
      }
      for (let index = Math.max(0, low - 1); index < this.points.length; index++) {
        const point = this.points[index]
        const x = scale.timeToCoordinate(point.time)
        const a = this.series.priceToCoordinate(point.a), b = this.series.priceToCoordinate(point.b)
        if (x === null || a === null || b === null) { previous = null; continue }
        const current = { x, a, b }
        if (previous && current.x >= 0 && previous.x <= mediaSize.width) {
          for (const polygon of cloudPolygons(previous, current)) {
            context.fillStyle = polygon.bullish ? CLOUD_COLORS.bullish : CLOUD_COLORS.bearish
            context.beginPath()
            polygon.vertices.forEach((vertex, index) => index === 0 ? context.moveTo(vertex.x, vertex.y) : context.lineTo(vertex.x, vertex.y))
            context.closePath(); context.fill()
          }
        }
        previous = current
        if (visible && typeof visible.to === 'number' && point.time > visible.to) break
      }
      context.restore()
      performanceEnd('cloud.draw', drawing)
    }),
  }
  private readonly views: IPrimitivePaneView[] = [{ zOrder: () => 'bottom', renderer: () => this.renderer }]
  attached({ chart, series, requestUpdate }: SeriesAttachedParameter): void {
    this.chart = chart; this.series = series as ISeriesApi<'Line'>; this.requestUpdate = requestUpdate
  }
  detached(): void { this.chart = null; this.series = null; this.requestUpdate = null; this.points = [] }
  setData(points: CloudPoint[]): void { this.points = points; this.requestUpdate?.() }
  updateTail(tail: CloudPoint[], cutoff: number, replace: boolean): void {
    let start = replace ? 0 : this.points.length
    while (start > 0 && this.points[start - 1].time >= cutoff) start--
    let changed = this.points.length - start !== tail.length
    for (let i = 0; !changed && i < tail.length; i++) {
      const old = this.points[start + i], next = tail[i]
      changed = old.time !== next.time || old.a !== next.a || old.b !== next.b
    }
    if (!changed) return
    this.points.length = start
    for (const point of tail) this.points.push(point)
    performanceCount('cloud.redraw')
    this.requestUpdate?.()
  }
  paneViews(): IPrimitivePaneView[] { return this.views }
}
