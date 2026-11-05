import type { IChartApi, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, SeriesAttachedParameter } from 'lightweight-charts'
import type { UntakenLevel } from './untakenLevels'

export const UNTAKEN_COLORS = { high: '#ef5350', low: '#26a69a' }
export class UntakenLevelsPrimitive implements ISeriesPrimitive {
  private chart: IChartApi | null = null
  private series: ISeriesApi<'Candlestick'> | null = null
  private requestUpdate: (() => void) | null = null
  private levels: readonly UntakenLevel[] = []
  private readonly renderer: IPrimitivePaneRenderer = {
    draw: target => target.useBitmapCoordinateSpace(({ context, bitmapSize, horizontalPixelRatio, verticalPixelRatio }) => {
      if (!this.chart || !this.series) return
      const scale = this.chart.timeScale(), visible = scale.getVisibleRange()
      context.save()
      context.beginPath(); context.rect(0, 0, bitmapSize.width, bitmapSize.height); context.clip()
      context.setLineDash([])
      context.lineWidth = Math.max(1, Math.floor(verticalPixelRatio))
      for (const level of this.levels) {
        const y = this.series.priceToCoordinate(level.price)
        if (y === null || y < 0 || y * verticalPixelRatio > bitmapSize.height) continue
        const x = visible && typeof visible.from === 'number' && level.time < visible.from ? 0 : scale.timeToCoordinate(level.time)
        if (x === null || x * horizontalPixelRatio > bitmapSize.width) continue
        const pixelY = Math.round(y * verticalPixelRatio) + (context.lineWidth % 2 ? 0.5 : 0)
        context.strokeStyle = UNTAKEN_COLORS[level.side]
        context.beginPath(); context.moveTo(Math.max(0, x * horizontalPixelRatio), pixelY)
        context.lineTo(bitmapSize.width, pixelY); context.stroke()
      }
      context.restore()
    }),
  }
  private readonly views: IPrimitivePaneView[] = [{ zOrder: () => 'bottom', renderer: () => this.renderer }]
  attached({ chart, series, requestUpdate }: SeriesAttachedParameter): void {
    this.chart = chart; this.series = series as ISeriesApi<'Candlestick'>; this.requestUpdate = requestUpdate
  }
  detached(): void { this.chart = null; this.series = null; this.requestUpdate = null; this.levels = [] }
  setData(levels: readonly UntakenLevel[]): void { this.levels = levels; this.requestUpdate?.() }
  paneViews(): IPrimitivePaneView[] { return this.views }
}
