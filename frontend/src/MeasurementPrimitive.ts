import type { IChartApi, Logical, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, SeriesAttachedParameter } from 'lightweight-charts'
import { measurementMetrics, type Measurement } from './measurement'

export class MeasurementPrimitive implements ISeriesPrimitive {
  private chart: IChartApi | null = null
  private series: ISeriesApi<'Candlestick'> | null = null
  private requestUpdate?: () => void
  private value: Measurement | null = null
  constructor(private pipSize: number, private overlaps: (x: number, y: number, width: number, height: number) => boolean = () => false) {}
  setData(value: Measurement | null) { this.value = value; this.requestUpdate?.() }
  attached({ chart, series, requestUpdate }: SeriesAttachedParameter) {
    this.chart = chart; this.series = series as ISeriesApi<'Candlestick'>; this.requestUpdate = requestUpdate
  }
  detached() { this.chart = null; this.series = null; this.requestUpdate = undefined; this.value = null }
  private readonly renderer: IPrimitivePaneRenderer = {
    draw: target => target.useMediaCoordinateSpace(({ context: ctx, mediaSize: size }) => {
      if (!this.value || !this.chart || !this.series) return
      const { start, end } = this.value, scale = this.chart.timeScale()
      const a = scale.timeToIndex(start.time), b = scale.timeToIndex(end.time)
      if (a === null || b === null) return
      const x1 = scale.logicalToCoordinate(a as number as Logical), x2 = scale.logicalToCoordinate(b as number as Logical)
      const y1 = this.series.priceToCoordinate(start.price), y2 = this.series.priceToCoordinate(end.price)
      if (x1 === null || x2 === null || y1 === null || y2 === null) return
      const { pips, pipLabel, spanLabel } = measurementMetrics(this.value, this.pipSize)
      const color = pips > 0 ? '#26a69a' : pips < 0 ? '#ef5350' : '#9598a1'
      const left = Math.min(x1, x2), top = Math.min(y1, y2), right = Math.max(x1, x2), bottom = Math.max(y1, y2)
      ctx.save()
      ctx.beginPath(); ctx.rect(0, 0, size.width, size.height); ctx.clip()
      ctx.fillStyle = pips > 0 ? '#26a69a26' : pips < 0 ? '#ef535026' : '#9598a126'
      ctx.fillRect(left, top, right - left, bottom - top)
      ctx.strokeStyle = color; ctx.lineWidth = 1
      ctx.strokeRect(left, top, right - left, bottom - top)
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()
      ctx.font = '12px Inter, system-ui, sans-serif'; ctx.textBaseline = 'middle'
      const width = Math.min(size.width - 8, Math.max(ctx.measureText(pipLabel).width, ctx.measureText(spanLabel).width) + 20), height = 46
      if (width <= 0 || size.height < height + 8) { ctx.restore(); return }
      const clampX = (x: number) => Math.max(4, Math.min(size.width - width - 4, x))
      const clampY = (y: number) => Math.max(4, Math.min(size.height - height - 4, y))
      const candidates = [[(left + right - width) / 2, bottom + 8], [(left + right - width) / 2, top - height - 8],
        [left - width - 8, (top + bottom - height) / 2], [right + 8, (top + bottom - height) / 2], [4, 4], [4, size.height - height - 4]]
        .map(([x, y]) => [clampX(x), clampY(y)])
      const [x, y] = candidates.find(([x, y]) => !this.overlaps(x, y, width, height)) ?? candidates[0]
      ctx.fillStyle = '#171e28'; ctx.fillRect(x, y, width, height)
      ctx.strokeRect(x, y, width, height)
      ctx.fillStyle = pips === 0 ? '#d1d4dc' : color
      ctx.fillText(pipLabel, x + 10, y + 14, width - 20)
      ctx.fillStyle = '#d1d4dc'; ctx.fillText(spanLabel, x + 10, y + 32, width - 20)
      ctx.restore()
    }),
  }
  private readonly views: IPrimitivePaneView[] = [{ zOrder: () => 'top', renderer: () => this.renderer }]
  paneViews() { return this.views }
}
