import { LineStyle, type AutoscaleInfo, type IPriceLine, type ISeriesApi } from 'lightweight-charts'
import { observedPrice, type TradingState } from './trading'
import { stopOverlays } from './stopOverlays'

export const ENTRY_COLOR = '#75c4b5'
export interface EntryOverlay { id: string; number: number; price: number; pending: boolean; label: string }

// Derived from durable trading records, including legacy sessions. A market
// order has no fill price until the next candle, so its reference is an estimate.
export function entryOverlays(state: TradingState): EntryOverlay[] {
  return stopOverlays(state).flatMap(stop => {
    const position = state.positions.find(p => p.id === stop.id)
    const pending = state.pending.find(p => p.id === stop.id)
    const price = position?.entryPrice ?? (pending ? observedPrice(state.quote, pending.direction) : null)
    return price === null ? [] : [{ id: stop.id, number: stop.number, price, pending: stop.pending,
      label: `${stop.pending ? 'Pending ' : ''}${(position ?? pending)!.direction === 'buy' ? 'B' : 'S'}${stop.number}${stop.pending ? ' (est.)' : ''}` }]
  })
}

export class EntryLines {
  private readonly lines = new Map<number, IPriceLine>()
  constructor(private readonly series: ISeriesApi<'Candlestick'>) {}
  update(entries: readonly EntryOverlay[]) {
    const prices = entries.map(entry => entry.price)
    // Price lines do not participate in the library's automatic price range.
    // Include live references while leaving fixed/manual price scales alone.
    this.series.applyOptions({ autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
      const info = original()
      return !info?.priceRange || !prices.length ? info : { ...info, priceRange: {
        minValue: Math.min(info.priceRange.minValue, ...prices),
        maxValue: Math.max(info.priceRange.maxValue, ...prices),
      } }
    } })
    // Coincident fills share a line with both identities, avoiding hidden labels.
    const groups = new Map<number, EntryOverlay[]>()
    for (const entry of entries) groups.set(entry.price, [...(groups.get(entry.price) ?? []), entry])
    for (const [price, line] of this.lines) {
      if (!groups.has(price)) { this.series.removePriceLine(line); this.lines.delete(price) }
    }
    for (const [price, group] of groups) {
      const options = { price, color: ENTRY_COLOR, lineWidth: 1 as const,
        lineStyle: group.every(entry => entry.pending) ? LineStyle.Dotted : LineStyle.Dashed,
        axisLabelVisible: true, title: group.map(entry => entry.label).join(' · ') }
      const line = this.lines.get(price)
      if (line) line.applyOptions(options)
      else this.lines.set(price, this.series.createPriceLine(options))
    }
  }
  dispose() { for (const line of this.lines.values()) this.series.removePriceLine(line); this.lines.clear() }
}
