import type { CandlestickData, UTCTimestamp } from 'lightweight-charts'

export interface Candle {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
}

export interface LegacyHistoryResponse {
  symbol: 'EURUSD'
  resolution: 'M1'
  from: string
  to: string
  bid: Candle[]
  ask: Candle[]
}

export interface ContractInterval { from: string; to: string; instrumentId: number; rawSymbol: string }
export interface TradeCandle extends Candle { volume: string; instrumentId: number }
export interface SinglePriceHistory {
  priceModel: 'single'; source: 'databento'; symbol: '6E'; dataset: 'GLBX.MDP3'; schema: 'ohlcv-1m'
  continuousSymbol: '6E.v.0'; stypeIn: 'continuous'; normalizationVersion: 1
  resolution: 'M1'; from: string; to: string
  contracts: ContractInterval[]; candles: TradeCandle[]
}
export interface ForexInstrument {
  symbol: string; baseCurrency: string; quoteCurrency: string; pipSize: number; priceDecimals: number; unitsPerLot: number
}
export interface LocalForexHistory {
  format: 'local-forex-v1'; source: 'local-parquet'; symbol: 'EURUSD'; resolution: 'M1'
  datasetId: string; sourceChecksum: string; normalizationVersion: 1
  priceModel: 'single'; priceBasis: 'mid'; executionModel: 'single-price-m1-v1'
  timestampConvention: 'utc-minute-open'; instrument: ForexInstrument
  from: string; to: string; candles: Candle[]
}
export type HistoryResponse = LegacyHistoryResponse | SinglePriceHistory | LocalForexHistory
export function isLocalForex(history: HistoryResponse): history is LocalForexHistory { return 'source' in history && history.source === 'local-parquet' }
export function isFuturesHistory(history: HistoryResponse): history is SinglePriceHistory { return 'source' in history && history.source === 'databento' }
export function isSinglePrice(history: HistoryResponse): history is SinglePriceHistory | LocalForexHistory { return 'priceModel' in history && history.priceModel === 'single' }
export function historyCandles(history: HistoryResponse): Candle[] { return isSinglePrice(history) ? history.candles : history.bid }
export function historyLabel(history: HistoryResponse | null): string { return !history || isLocalForex(history) ? 'EURUSD · local archive · mid prices' : history && !isSinglePrice(history) ? 'EURUSD · Dukascopy · legacy bid/ask' : '6E — Euro FX Futures · Databento · trade prices' }
export function rolloverIndex(candles: readonly Candle[], start: number): number {
  const first = (candles[start] as TradeCandle | undefined)?.instrumentId
  if (first === undefined) return candles.length
  const index = candles.findIndex((bar, index) => index > start && (bar as TradeCandle).instrumentId !== first)
  return index < 0 ? candles.length : index
}

export interface DateRange {
  from: string
  to: string
}

export const MAX_BACKTEST_DAYS = 365
export const HISTORY_PREROLL_DAYS = 30
export const BACKTEST_DAY_PRESETS = [7, 30, 90, 365] as const

export class HistoryRequestError extends Error {
  override name = 'HistoryRequestError'
  constructor(message: string, readonly code: string, readonly title = 'Historical data unavailable', readonly retryAfterMs?: number) {
    super(message)
  }
}

export const TIMEFRAMES = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'] as const
export const VISIBLE_TIMEFRAMES = ['M5', 'M15', 'H1', 'H4', 'D1'] as const
export type Timeframe = typeof TIMEFRAMES[number]

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  M1: 60_000, M5: 300_000, M15: 900_000, H1: 3_600_000, H4: 14_400_000, D1: 86_400_000,
}

export function aggregateBidCandles(candles: readonly Candle[], timeframe: Timeframe): Candle[] {
  if (timeframe === 'M1') return [...candles]
  const width = TIMEFRAME_MS[timeframe]
  const aggregated: Candle[] = []
  for (const candle of candles) {
    const timestamp = Math.floor(candle.timestamp / width) * width
    const previous = aggregated[aggregated.length - 1]
    if (previous && Math.floor(previous.timestamp / width) * width === timestamp && (previous as Partial<TradeCandle>).instrumentId === (candle as Partial<TradeCandle>).instrumentId) {
      previous.high = Math.max(previous.high, candle.high)
      previous.low = Math.min(previous.low, candle.low)
      previous.close = candle.close
    } else {
      // Keep contract segments separate, even when a switch falls inside a coarse bucket.
      const time = previous && Math.floor(previous.timestamp / width) * width === timestamp ? candle.timestamp : timestamp
      aggregated.push({ timestamp: time, open: candle.open, high: candle.high, low: candle.low, close: candle.close,
        ...('instrumentId' in candle ? { instrumentId: candle.instrumentId } : {}) })
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
    toMs > todayMs || (toMs - fromMs) / DAY_MS > MAX_BACKTEST_DAYS) {
    return `Choose 1 to ${MAX_BACKTEST_DAYS} completed UTC days. Start is inclusive; end is exclusive.`
  }
  return null
}

export function isRecord(value: unknown): value is Record<string, unknown> {
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
  if (!isRecord(value) || value.resolution !== 'M1' || value.from !== range.from || value.to !== range.to ||
    utcDate(range.from) === null || utcDate(range.to) === null || range.from >= range.to) throw new Error('Historical data has an unexpected response format.')
  const fromMs = utcDate(range.from)!, toMs = utcDate(range.to)!
  if (value.source === 'local-parquet') {
    const instrument = value.instrument
    if (value.format !== 'local-forex-v1' || value.symbol !== 'EURUSD' || value.priceModel !== 'single' ||
      value.priceBasis !== 'mid' || value.executionModel !== 'single-price-m1-v1' || value.timestampConvention !== 'utc-minute-open' ||
      value.normalizationVersion !== 1 || typeof value.datasetId !== 'string' || !/^[a-f0-9]{64}$/.test(value.datasetId) ||
      value.sourceChecksum !== value.datasetId || !isRecord(instrument) || instrument.symbol !== 'EURUSD' ||
      instrument.baseCurrency !== 'EUR' || instrument.quoteCurrency !== 'USD' || instrument.pipSize !== 0.0001 ||
      instrument.unitsPerLot !== 100000 || instrument.priceDecimals !== 7 ||
      ['bid', 'ask', 'contracts', 'continuousSymbol', 'volume', 'stypeIn', 'dataset', 'schema'].some(key => key in value) ||
      !Array.isArray(value.candles) || value.candles.some((bar: unknown) => !isRecord(bar) || Object.keys(bar).some(key => !['timestamp','open','high','low','close'].includes(key)))) {
      throw new Error('Invalid local Forex history identity.')
    }
    return { format: 'local-forex-v1', source: 'local-parquet', symbol: 'EURUSD', resolution: 'M1',
      datasetId: value.datasetId, sourceChecksum: value.sourceChecksum, normalizationVersion: 1,
      priceModel: 'single', priceBasis: 'mid', executionModel: 'single-price-m1-v1', timestampConvention: 'utc-minute-open',
      instrument: { symbol: 'EURUSD', baseCurrency: 'EUR', quoteCurrency: 'USD', pipSize: 0.0001, unitsPerLot: 100000, priceDecimals: 7 },
      from: range.from, to: range.to, candles: parseCandles(value.candles, fromMs, toMs) }
  }
  if (value.priceModel === 'single') {
    if (value.source !== 'databento' || value.symbol !== '6E' || value.dataset !== 'GLBX.MDP3' || value.schema !== 'ohlcv-1m' ||
      value.continuousSymbol !== '6E.v.0' || value.stypeIn !== 'continuous' || value.normalizationVersion !== 1 ||
      'bid' in value || 'ask' in value || !Array.isArray(value.contracts) || !value.contracts.length) throw new Error('Invalid Databento history identity.')
    let boundary = range.from
    const contracts = value.contracts.map((item: unknown): ContractInterval => {
      if (!isRecord(item) || typeof item.from !== 'string' || typeof item.to !== 'string' || utcDate(item.from) === null || utcDate(item.to) === null ||
        item.from !== boundary || item.from >= item.to || item.to > range.to || typeof item.instrumentId !== 'number' || !Number.isSafeInteger(item.instrumentId) || item.instrumentId <= 0 ||
        typeof item.rawSymbol !== 'string' || !/^6E[FGHJKMNQUVXZ]\d{1,2}$/.test(item.rawSymbol)) throw new Error('Invalid or incomplete contract mapping.')
      boundary = item.to
      return { from: item.from, to: item.to, instrumentId: item.instrumentId, rawSymbol: item.rawSymbol }
    })
    if (boundary !== range.to) throw new Error('Incomplete contract mapping.')
    const base = parseCandles(value.candles, fromMs, toMs)
    const candles = base.map((bar, index): TradeCandle => {
      const item = (value.candles as Record<string, unknown>[])[index]
      const contract = contracts.find(c => bar.timestamp >= Date.parse(c.from) && bar.timestamp < Date.parse(c.to))
      if (typeof item.volume !== 'string' || !/^(0|[1-9]\d*)$/.test(item.volume) || BigInt(item.volume) > 18446744073709551615n ||
        item.volume === '0' || item.instrumentId !== contract?.instrumentId) throw new Error('Invalid trade volume or contract identity.')
      return { ...bar, volume: item.volume, instrumentId: contract!.instrumentId }
    })
    return { priceModel: 'single', source: 'databento', symbol: '6E', dataset: 'GLBX.MDP3', schema: 'ohlcv-1m', continuousSymbol: '6E.v.0',
      stypeIn: 'continuous', normalizationVersion: 1, resolution: 'M1', from: range.from, to: range.to, contracts, candles }
  }
  if (value.symbol !== 'EURUSD' || 'priceModel' in value || 'source' in value || 'candles' in value) throw new Error('Invalid legacy history identity.')
  return { symbol: 'EURUSD', resolution: 'M1', from: range.from, to: range.to,
    bid: parseCandles(value.bid, fromMs, toMs), ask: parseCandles(value.ask, fromMs, toMs) }
}

export function toBidChartCandles(history: HistoryResponse | { bid: readonly Candle[] }, timeframe: Timeframe = 'M1'): CandlestickData<UTCTimestamp>[] {
  return aggregateBidCandles('symbol' in history ? historyCandles(history) : history.bid, timeframe).map(({ timestamp, open, high, low, close }) => ({
    time: (timestamp / 1000) as UTCTimestamp,
    open, high, low, close,
  }))
}

export async function fetchHistory(range: DateRange, signal?: AbortSignal): Promise<HistoryResponse> {
  const params = new URLSearchParams({ symbol: 'EURUSD', from: range.from, to: range.to, tradingFrom: new Date(Date.parse(range.from) + HISTORY_PREROLL_DAYS * DAY_MS).toISOString().slice(0,10) })
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
