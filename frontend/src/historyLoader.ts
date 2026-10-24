import { aggregateBidCandles, fetchHistory, HistoryRequestError, parseHistory, validateDateRange, NORMALIZATION_VERSION, type HistoryProvider, type ProviderProvenance, type Candle, type DateRange, type HistoryResponse } from './history.js'

const DAY = 86_400_000
const date = (ms: number) => new Date(ms).toISOString().slice(0, 10)
export const PREROLL_DAYS = 30
export interface LoadedHistory extends HistoryResponse { tradingFrom: string }
export interface LoadProgress { completed: number; total: number }

export function historyChunks(range: DateRange): DateRange[] {
  const chunks: DateRange[] = []
  const end = Date.parse(range.to)
  for (let start = Date.parse(range.from); start < end; start += 7 * DAY) {
    chunks.push({ from: date(start), to: date(Math.min(end, start + 7 * DAY)) })
  }
  return chunks
}

export function mergeCandles(parts: readonly (readonly Candle[])[]): Candle[] {
  const observations = new Map<number, Candle>()
  for (const part of parts) for (const candle of part) {
    const old = observations.get(candle.timestamp)
    if (old && (old.open !== candle.open || old.high !== candle.high || old.low !== candle.low || old.close !== candle.close)) {
      throw new Error(`Conflicting historical observations at ${new Date(candle.timestamp).toISOString()}.`)
    }
    observations.set(candle.timestamp, candle)
  }
  return [...observations.values()].sort((a, b) => a.timestamp - b.timestamp)
}

// One loader per mounted application. Successful chunks survive retries; incomplete
// intervals never become replay datasets. The provider's daily disk cache remains authoritative.
export class HistoryLoader {
  private cache = new Map<string, HistoryResponse>()
  constructor(private download = fetchHistory) {}

  async load(range: DateRange, signal: AbortSignal, progress: (value: LoadProgress) => void, provider?: HistoryProvider): Promise<LoadedHistory> {
    const error = validateDateRange(range)
    if (error) throw new Error(error)
    const warmup = { from: date(Date.parse(range.from) - PREROLL_DAYS * DAY), to: range.from }
    const chunks = [...historyChunks(warmup), ...historyChunks(range)]
    const results: HistoryResponse[] = new Array(chunks.length)
    let next = 0, completed = 0, failed: Error | null = null
    progress({ completed, total: chunks.length })
    const worker = async () => {
      while (next < chunks.length && !failed) {
        signal.throwIfAborted()
        const index = next++, chunk = chunks[index], key = `${provider ?? 'legacy-dukascopy'}/${NORMALIZATION_VERSION}/${chunk.from}/${chunk.to}`
        try {
          let result = this.cache.get(key)
          if (!result) {
            result = parseHistory(await this.download(chunk, signal, provider), chunk)
            if ((provider && result.provenance?.provider !== provider) || (!provider && result.provenance && result.provenance.provider !== 'dukascopy')) throw new Error('Historical response does not match the selected provider.')
            signal.throwIfAborted()
            // fetchHistory validates every response, including range and independent sides.
            this.cache.set(key, result)
            if (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value!)
          }
          results[index] = result
          progress({ completed: ++completed, total: chunks.length })
        } catch (reason) {
          signal.throwIfAborted()
          const message = `${reason instanceof Error ? reason.message : 'Historical data is unavailable.'} Chunk ${index + 1}/${chunks.length} (${chunk.from} to ${chunk.to} UTC) failed. Retry to complete the interval.`
          failed ??= reason instanceof HistoryRequestError
            ? new HistoryRequestError(message, reason.code, reason.title, reason.retryAfterMs)
            : new Error(message)
        }
      }
    }
    await Promise.all([worker(), worker()])
    signal.throwIfAborted()
    if (failed) throw failed
    const provenance: ProviderProvenance | undefined = provider ? { version: 2, provider, normalizationVersion: NORMALIZATION_VERSION,
      ...(provider === 'fxcm' ? { sources: [...new Map(results.flatMap(r => r.provenance?.sources ?? []).map(source => [source.file, source])).values()].sort((a, b) => a.first - b.first) } : {}) } : undefined
    return { ...(provenance ? { provenance } : {}), symbol: 'EURUSD', resolution: 'M1', from: warmup.from, to: range.to, tradingFrom: range.from,
      bid: mergeCandles(results.map((result) => result.bid)), ask: mergeCandles(results.map((result) => result.ask)) }
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
