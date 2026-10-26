import { aggregateBidCandles, fetchHistory, HISTORY_PREROLL_DAYS, parseHistory, validateDateRange, type Candle, type DateRange, type HistoryFetchRange, type HistoryResponse, type Timeframe, type TradeCandle } from './history.js'

const DAY = 86_400_000
const date = (ms: number) => new Date(ms).toISOString().slice(0, 10)
export const PREROLL_DAYS = HISTORY_PREROLL_DAYS
export type LoadedHistory = HistoryResponse & { tradingFrom: string }
export interface LoadProgress { completed: number; total: number }

// Read installed observations from the exact indicator warm-up boundary, or
// the replay boundary when no warm-up is required. Omitted bounds retain the
// legacy pre-roll for existing callers.
export class HistoryLoader {
  constructor(private download: (range: HistoryFetchRange, signal?: AbortSignal) => Promise<HistoryResponse> = fetchHistory) {}
  async load(range: DateRange, signal: AbortSignal, progress: (value: LoadProgress) => void, warmupFrom?: string): Promise<LoadedHistory> {
    const error = validateDateRange(range)
    if (error) throw new Error(error)
    const from = warmupFrom ?? date(Date.parse(range.from) - PREROLL_DAYS * DAY)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !Number.isFinite(Date.parse(from)) || date(Date.parse(from)) !== from || Date.parse(from) > Date.parse(range.from)) throw new Error('History must begin on or before the replay period.')
    const full = { from, to: range.to, tradingFrom: range.from }
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

export function indicatorWarmup(candles: readonly Candle[], start: number, timeframe: Timeframe, required: number) {
  const target = (candles[replayStartIndex(candles, start)] ?? candles.at(-1)) as TradeCandle | undefined
  let first = replayStartIndex(candles, start)
  while (first > 0 && (candles[first - 1] as TradeCandle).instrumentId === target?.instrumentId) first--
  const width = timeframe === 'M1' ? 60_000 : timeframe === 'M5' ? 300_000 : timeframe === 'M15' ? 900_000 : timeframe === 'H1' ? 3_600_000 : timeframe === 'H4' ? 14_400_000 : DAY
  const count = aggregateBidCandles(candles.slice(first).filter((bar) => bar.timestamp < start), timeframe)
    .filter(bar => Math.floor(bar.timestamp / width) * width + width <= start).length
  return { count, required, ready: count >= required }
}

export function ichimokuWarmup(candles: readonly Candle[], start: number, settings = { tenkan: 9, kijun: 26, spanB: 52, displacement: 26 }, timeframe: Timeframe = 'D1') {
  // A paired cloud at the replay edge needs its longest lookback plus forward displacement.
  const required = Math.max(settings.tenkan, settings.kijun, settings.spanB) + settings.displacement
  return indicatorWarmup(candles, start, timeframe, required)
}
