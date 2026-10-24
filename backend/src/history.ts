import { getHistoricalRates, instrumentMetaData, type ConfigJsonItem, type JsonItem } from 'dukascopy-node'
import { checkProviderBrowser } from './providerBrowser.js'
import { join } from 'node:path'
import { projectRoot, providerCachePaths } from './projectPaths.js'

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

export type RatesFetcher = (config: ConfigJsonItem) => Promise<JsonItem[]>


function normalizeCandles(items: JsonItem[], from: number, to: number): Candle[] {
  const byTimestamp = new Map<number, Candle>()

  for (const item of items) {
    const { timestamp, open, high, low, close } = item
    const prices = [open, high, low, close]
    if (!Number.isSafeInteger(timestamp) || timestamp % 60_000 !== 0 || timestamp < from || timestamp >= to ||
      prices.some((price) => !Number.isFinite(price) || price <= 0) ||
      low > Math.min(open, close) || high < Math.max(open, close) || low > high) {
      throw new Error('Invalid candle from data provider')
    }

    const candle = { timestamp, open, high, low, close }
    const existing = byTimestamp.get(timestamp)
    if (existing && (existing.open !== open || existing.high !== high || existing.low !== low || existing.close !== close)) {
      throw new Error('Conflicting candles from data provider')
    }
    byTimestamp.set(timestamp, candle)
  }

  return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp)
}

export async function loadHistory(from: string, to: string, fetchRates: RatesFetcher = getHistoricalRates): Promise<HistoryResponse> {
  const first = Date.parse(instrumentMetaData.eurusd.startDayForMinuteCandles)
  if (Date.parse(to) <= first) return { symbol: 'EURUSD', resolution: 'M1', from, to, bid: [], ask: [] }
  if (fetchRates === getHistoricalRates) await checkProviderBrowser()
  const dates = { from: new Date(Math.max(Date.parse(from), first)), to: new Date(`${to}T00:00:00.000Z`) }
  const baseConfig: ConfigJsonItem = {
    instrument: 'eurusd',
    dates,
    timeframe: 'm1',
    format: 'json',
    utcOffset: 0,
    useCache: true,
    ...await providerCachePaths(),
    ...(process.platform === 'linux' ? { chromePath: join(projectRoot, 'scripts/provider-browser.sh') }
      : process.env.DUKASCOPY_CHROME_PATH ? { chromePath: process.env.DUKASCOPY_CHROME_PATH } : {}),
    retryCount: 2,
  }

  const bid = await fetchRates({ ...baseConfig, priceType: 'bid' })
  const ask = await fetchRates({ ...baseConfig, priceType: 'ask' })

  return {
    symbol: 'EURUSD',
    resolution: 'M1',
    from,
    to,
    bid: normalizeCandles(bid, dates.from.getTime(), dates.to.getTime()),
    ask: normalizeCandles(ask, dates.from.getTime(), dates.to.getTime()),
  }
}
