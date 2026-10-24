import { aggregateBidCandles, fetchHistory, parseHistory, validateDateRange, type Candle, type DateRange, type HistoryResponse } from './history.js'

const DAY = 86_400_000
const date = (ms: number) => new Date(ms).toISOString().slice(0, 10)
export const PREROLL_DAYS = 30
export type LoadedHistory = HistoryResponse & { tradingFrom: string }
export interface LoadProgress { completed: number; total: number }

// This path can only read cached history. New paid downloads use quoteHistory/downloadHistory.
export class HistoryLoader {
  constructor(private download = fetchHistory) {}
  async load(range: DateRange, signal: AbortSignal, progress: (value: LoadProgress) => void): Promise<LoadedHistory> {
    const error = validateDateRange(range)
    if (error) throw new Error(error)
    const full = { from: date(Date.parse(range.from) - PREROLL_DAYS * DAY), to: range.to }
    progress({ completed: 0, total: 1 })
    const history = parseHistory(await this.download(full, signal), full)
    signal.throwIfAborted()
    progress({ completed: 1, total: 1 })
    return { ...history, tradingFrom: range.from }
  }
}

export function replayStartIndex(candles: readonly Candle[], timestamp: number): number {
  let low = 0, high = candles.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (candles[middle].timestamp < timestamp) low = middle + 1
    else high = middle
  }
  return low
}

export function ichimokuWarmup(candles: readonly Candle[], start: number, settings = { tenkan: 9, kijun: 26, spanB: 52, displacement: 26 }) {
  const count = aggregateBidCandles(candles.filter((bar) => bar.timestamp < start), 'H4').length
  // A paired cloud at the replay edge needs its lookback plus forward displacement.
  const required = Math.max(settings.tenkan, settings.kijun, settings.spanB) + settings.displacement
  return { count, required, ready: count >= required }
}
