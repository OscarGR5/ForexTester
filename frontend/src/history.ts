import type { CandlestickData, UTCTimestamp } from 'lightweight-charts'

export interface Candle {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
}

export interface HistoryResponse {
  symbol: 'EURUSD'
  resolution: 'M1'
  from: string
  to: string
  bid: Candle[]
  ask: Candle[]
}

export interface DateRange {
  from: string
  to: string
}

export class HistoryRequestError extends Error {
  override name = 'HistoryRequestError'
  constructor(message: string, readonly code: string, readonly title = 'Historical data unavailable', readonly retryAfterMs?: number) {
    super(message)
  }
}

export const TIMEFRAMES = ['M1', 'M5', 'M15', 'H1', 'H4'] as const
export type Timeframe = typeof TIMEFRAMES[number]

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  M1: 60_000, M5: 300_000, M15: 900_000, H1: 3_600_000, H4: 14_400_000,
}

export function aggregateBidCandles(candles: readonly Candle[], timeframe: Timeframe): Candle[] {
  if (timeframe === 'M1') return [...candles]
  const width = TIMEFRAME_MS[timeframe]
  const aggregated: Candle[] = []
  for (const candle of candles) {
    const timestamp = Math.floor(candle.timestamp / width) * width
    const previous = aggregated[aggregated.length - 1]
    if (previous?.timestamp === timestamp) {
      previous.high = Math.max(previous.high, candle.high)
      previous.low = Math.min(previous.low, candle.low)
      previous.close = candle.close
    } else {
      aggregated.push({ timestamp, open: candle.open, high: candle.high, low: candle.low, close: candle.close })
    }
  }
  return aggregated
}

const DAY_MS = 86_400_000

function utcDate(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const timestamp = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
    ? timestamp
    : null
}

export function validateDateRange({ from, to }: DateRange, todayUtc = new Date().toISOString().slice(0, 10)): string | null {
  const fromMs = utcDate(from)
  const toMs = utcDate(to)
  const todayMs = utcDate(todayUtc)
  if (fromMs === null || toMs === null || todayMs === null || fromMs >= toMs ||
    toMs > todayMs || (toMs - fromMs) / DAY_MS > 90) {
    return 'Choose 1 to 90 completed UTC days. Start is inclusive; end is exclusive.'
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseCandles(value: unknown, fromMs: number, toMs: number): Candle[] {
  if (!Array.isArray(value)) throw new Error('Historical data has an invalid candle list.')
  let previousTimestamp = -1
  return value.map((item: unknown) => {
    if (!isRecord(item)) throw new Error('Historical data contains an invalid candle.')
    const { timestamp, open, high, low, close } = item
    if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp % 60_000 !== 0 ||
      timestamp < fromMs || timestamp >= toMs || timestamp <= previousTimestamp ||
      typeof open !== 'number' || typeof high !== 'number' || typeof low !== 'number' || typeof close !== 'number' ||
      ![open, high, low, close].every((price) => Number.isFinite(price) && price > 0) ||
      low > Math.min(open, close) || high < Math.max(open, close) || low > high) {
      throw new Error('Historical data contains an invalid candle.')
    }
    previousTimestamp = timestamp
    return { timestamp, open, high, low, close }
  })
}

export function parseHistory(value: unknown, range: DateRange): HistoryResponse {
  if (!isRecord(value) || value.symbol !== 'EURUSD' || value.resolution !== 'M1' ||
    value.from !== range.from || value.to !== range.to) {
    throw new Error('Historical data has an unexpected response format.')
  }
  const fromMs = utcDate(range.from)!
  const toMs = utcDate(range.to)!
  return {
    symbol: 'EURUSD', resolution: 'M1', from: range.from, to: range.to,
    bid: parseCandles(value.bid, fromMs, toMs),
    ask: parseCandles(value.ask, fromMs, toMs),
  }
}

export function toBidChartCandles(history: { bid: readonly Candle[] }, timeframe: Timeframe = 'M1'): CandlestickData<UTCTimestamp>[] {
  return aggregateBidCandles(history.bid, timeframe).map(({ timestamp, open, high, low, close }) => ({
    time: (timestamp / 1000) as UTCTimestamp,
    open, high, low, close,
  }))
}

export async function fetchHistory(range: DateRange, signal?: AbortSignal): Promise<HistoryResponse> {
  const params = new URLSearchParams({ symbol: 'EURUSD', from: range.from, to: range.to })
  let response: Response
  try { response = await fetch(`/api/history?${params}`, { signal }) }
  catch {
    signal?.throwIfAborted()
    throw new HistoryRequestError('The backend could not be reached. Check the backend and network connection, then retry.', 'BACKEND_NETWORK', 'Backend connection unavailable')
  }
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = isRecord(body) && typeof body.error === 'string'
      ? `${body.error}${typeof body.action === 'string' ? ` ${body.action}` : ''}`
      : `Historical data request failed (HTTP ${response.status}).`
    const retryAfterMs = isRecord(body) && typeof body.retryAfterMs === 'number' && Number.isSafeInteger(body.retryAfterMs) && body.retryAfterMs >= 0 ? body.retryAfterMs : undefined
    throw new HistoryRequestError(message, isRecord(body) && typeof body.code === 'string' ? body.code : 'HISTORY_UNAVAILABLE',
      isRecord(body) && typeof body.title === 'string' ? body.title : 'Historical data unavailable', retryAfterMs)
  }
  return parseHistory(body, range)
}
