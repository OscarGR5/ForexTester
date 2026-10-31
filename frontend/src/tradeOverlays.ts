import type { IChartApi, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, SeriesAttachedParameter } from 'lightweight-charts'
import { TIMEFRAME_MS, type Timeframe } from './history'
import type { ChartCandle } from './indicators'
import type { ClosedTrade, Direction, Position } from './trading'

export interface ExecutionPoint { timestamp: number; price: number; direction: Direction }
export interface HistoricalStop { from: number; to: number; price: number }
export interface TradeOverlayRecord { id: string; entry: ExecutionPoint; exit: ExecutionPoint | null; stops: HistoricalStop[] }
const BUY = '#75c4b5', SELL = '#e2a2a6'

// Read only durable fills and modifications. Pending orders have no execution.
export function tradeOverlayRecords(positions: readonly Position[], closed: readonly ClosedTrade[]): TradeOverlayRecord[] {
  return [...positions, ...closed].map(position => {
    const exit = 'exitTime' in position ? position as ClosedTrade : null
    const stops: HistoricalStop[] = []
    let from = position.entryTime, price = position.initialStopPrice
    for (const change of position.stopModifications) {
      stops.push({ from, to: change.timestamp, price })
      from = change.timestamp; price = change.newPrice
    }
    if (exit) stops.push({ from, to: exit.exitTime, price })
    return { id: position.id, entry: { timestamp: position.entryTime, price: position.entryPrice, direction: position.direction },
      exit: exit ? { timestamp: exit.exitTime, price: exit.exitPrice, direction: position.direction === 'buy' ? 'sell' : 'buy' } : null, stops }
  })
}

// Fractional logical coordinates retain the actual M1 execution time inside a
// larger candle. No additional series/time slots or snapped candle timestamps.
export function executionLogical(timestamp: number, candles: readonly ChartCandle[], timeframe: Timeframe): number | null {
  const seconds = timestamp / 1000
  let low = 0, high = candles.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (Number(candles[middle].time) <= seconds) low = middle + 1
    else high = middle
  }
  const index = low - 1
  if (index < 0) return null
  const fraction = (seconds - Number(candles[index].time)) / (TIMEFRAME_MS[timeframe] / 1000)
  // Reject gaps and timestamps outside the supplied candle bucket.
  return fraction < 1 ? index + fraction : null
}

export class TradeOverlays implements ISeriesPrimitive {
  private chart: IChartApi | null = null
  private series: ISeriesApi<'Candlestick'> | null = null
  private requestUpdate: (() => void) | null = null
  private records: readonly TradeOverlayRecord[] = []
  private candles: readonly ChartCandle[] = []
  private timeframe: Timeframe = 'M1'
  private cutoff = 0
  private executions = false
  private history = false
  private readonly renderer: IPrimitivePaneRenderer = {
    draw: target => target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      if (!this.chart || !this.series || (!this.executions && !this.history)) return
      const scale = this.chart.timeScale()
      const visible = scale.getVisibleRange()
      const left = typeof visible?.from === 'number' ? visible.from * 1000 : -Infinity
      const right = typeof visible?.to === 'number' ? visible.to * 1000 + TIMEFRAME_MS[this.timeframe] : Infinity
      const visibleRecord = (record: TradeOverlayRecord) => record.entry.timestamp <= right && (!record.exit || record.exit.timestamp >= left)
      const xAt = (timestamp: number) => {
        const logical = executionLogical(timestamp, this.candles, this.timeframe)
        if (logical === null) return null
        const index = Math.floor(logical), anchor = scale.timeToCoordinate(this.candles[index].time)
        // Indicator whitespace can add global time slots. Anchor to the candle's
        // real time rather than assuming its array index is a chart index.
        return anchor === null ? null : anchor + (logical - index) * scale.options().barSpacing
      }
      const point = (execution: ExecutionPoint) => {
        const x = xAt(execution.timestamp), y = this.series!.priceToCoordinate(execution.price)
        return x === null || y === null ? null : { x, y }
      }
      const triangle = (execution: ExecutionPoint) => {
        const p = point(execution)
        if (!p || p.x < -5 || p.x > mediaSize.width + 5 || p.y < -5 || p.y > mediaSize.height + 5) return
        const sign = execution.direction === 'buy' ? 1 : -1
        ctx.fillStyle = execution.direction === 'buy' ? BUY : SELL
        ctx.beginPath(); ctx.moveTo(p.x, p.y - sign * 4); ctx.lineTo(p.x - 4, p.y + sign * 3); ctx.lineTo(p.x + 4, p.y + sign * 3); ctx.closePath(); ctx.fill()
      }
      ctx.save()
      ctx.beginPath(); ctx.rect(0, 0, mediaSize.width, mediaSize.height); ctx.clip()
      // History sits beneath executions and never changes the active SL lines,
      // annotations, hit targets or automatic price range.
      if (this.history) {
        ctx.strokeStyle = 'rgba(239, 154, 154, 0.28)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4])
        for (const record of this.records) for (const stop of record.stops) {
          // Only currently open positions retain history; close requests have no exit.
          if (record.exit || stop.to > this.cutoff) continue
          const y = this.series.priceToCoordinate(stop.price)
          if (y === null || y < 0 || y > mediaSize.height) continue
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(mediaSize.width, y); ctx.stroke()
        }
      }
      if (this.executions) {
        ctx.lineWidth = 1
        for (const record of this.records) {
          if (record.entry.timestamp > this.cutoff || !visibleRecord(record)) continue
          const exit = record.exit && record.exit.timestamp <= this.cutoff ? record.exit : null
          if (exit) {
            const a = point(record.entry), b = point(exit)
            if (a && b && Math.max(a.x, b.x) >= 0 && Math.min(a.x, b.x) <= mediaSize.width) {
              ctx.strokeStyle = record.entry.direction === 'buy' ? 'rgba(117, 196, 181, 0.45)' : 'rgba(226, 162, 166, 0.45)'
              ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
              const angle = Math.atan2(b.y - a.y, b.x - a.x)
              ctx.setLineDash([]); ctx.beginPath()
              ctx.moveTo(b.x - 6 * Math.cos(angle - .5), b.y - 6 * Math.sin(angle - .5)); ctx.lineTo(b.x, b.y)
              ctx.lineTo(b.x - 6 * Math.cos(angle + .5), b.y - 6 * Math.sin(angle + .5)); ctx.stroke()
            }
          }
        }
        ctx.setLineDash([])
        for (const record of this.records) {
          if (!visibleRecord(record)) continue
          if (record.entry.timestamp <= this.cutoff) triangle(record.entry)
          if (record.exit && record.exit.timestamp <= this.cutoff) triangle(record.exit)
        }
      }
      ctx.restore()
    }),
  }
  private readonly views: IPrimitivePaneView[] = [{ zOrder: () => 'normal', renderer: () => this.renderer }]
  attached({ chart, series, requestUpdate }: SeriesAttachedParameter) { this.chart = chart; this.series = series as ISeriesApi<'Candlestick'>; this.requestUpdate = requestUpdate }
  detached() { this.chart = null; this.series = null; this.requestUpdate = null }
  paneViews() { return this.views }
  update(records: readonly TradeOverlayRecord[], candles: readonly ChartCandle[], timeframe: Timeframe, cutoff: number, executions: boolean, history: boolean) {
    this.records = records; this.candles = candles; this.timeframe = timeframe; this.cutoff = cutoff; this.executions = executions; this.history = history
    this.requestUpdate?.()
  }
}
