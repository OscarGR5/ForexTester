import { afterEach, describe, expect, it, vi } from 'vitest'
import { aggregateBidCandles, fetchHistory, parseHistory, TIMEFRAMES, toBidChartCandles, validateDateRange, type Candle } from './history'

const range = { from: '2024-01-09', to: '2024-01-10' }
const bid = { timestamp: 1704758400000, open: 1.09497, high: 1.09504, low: 1.09492, close: 1.09501 }
const ask = { timestamp: 1704758400000, open: 1.09499, high: 1.09509, low: 1.09496, close: 1.09504 }
const response = { symbol: 'EURUSD', resolution: 'M1', ...range, bid: [bid], ask: [ask] }

afterEach(() => vi.unstubAllGlobals())

describe('historical chart data', () => {
  it('aggregates every supported timeframe on UTC boundaries with first open and last close', () => {
    const base = Date.UTC(2024, 0, 9)
    const minute = (offset: number, open: number, high: number, low: number, close: number): Candle =>
      ({ timestamp: base + offset * 60_000, open, high, low, close })
    const source = [minute(2, 1.1, 1.3, 1.0, 1.2), minute(4, 1.2, 1.4, 1.1, 1.3),
      minute(5, 1.3, 1.5, 1.2, 1.4), minute(15, 1.4, 1.6, 1.3, 1.5),
      minute(60, 1.5, 1.7, 1.4, 1.6), minute(240, 1.6, 1.8, 1.5, 1.7)]
    const buckets = { M1: [2, 4, 5, 15, 60, 240], M5: [0, 5, 15, 60, 240],
      M15: [0, 15, 60, 240], H1: [0, 60, 240], H4: [0, 240] }
    for (const timeframe of TIMEFRAMES) {
      expect(aggregateBidCandles(source, timeframe).map((candle) => (candle.timestamp - base) / 60_000)).toEqual(buckets[timeframe])
    }
    expect(aggregateBidCandles(source, 'M5')[0]).toEqual(minute(0, 1.1, 1.4, 1.0, 1.3))
    expect(aggregateBidCandles(source, 'H4')[0]).toEqual(minute(0, 1.1, 1.7, 1.0, 1.6))
    expect(source[0].timestamp).toBe(base + 120_000)
  })

  it('keeps sparse and partial buckets, including day and H4 UTC boundaries', () => {
    const start = Date.UTC(2024, 0, 9, 3, 59)
    const source = [
      { timestamp: start, open: 1, high: 2, low: 1, close: 1.5 },
      { timestamp: start + 2 * 60_000, open: 1.5, high: 3, low: 1, close: 2 },
      { timestamp: start + 21 * 60_000, open: 2, high: 4, low: 2, close: 3 },
    ]
    expect(aggregateBidCandles(source, 'H4').map((candle) => candle.timestamp)).toEqual([
      Date.UTC(2024, 0, 9), Date.UTC(2024, 0, 9, 4),
    ])
    expect(aggregateBidCandles(source, 'M5').map((candle) => candle.timestamp)).toEqual([
      Date.UTC(2024, 0, 9, 3, 55), Date.UTC(2024, 0, 9, 4), Date.UTC(2024, 0, 9, 4, 20),
    ])
    expect(aggregateBidCandles([], 'M15')).toEqual([])
  })

  it('converts milliseconds to UTC seconds and maps only bid OHLC values', () => {
    const history = parseHistory(response, range)
    expect(history.ask).toEqual([ask])
    expect(toBidChartCandles(history)).toEqual([
      { time: 1704758400, open: 1.09497, high: 1.09504, low: 1.09492, close: 1.09501 },
    ])
  })

  it('keeps missing intervals missing and handles empty bid and ask arrays', () => {
    const later = { ...bid, timestamp: bid.timestamp + 120_000 }
    const history = parseHistory({ ...response, bid: [bid, later] }, range)
    expect(toBidChartCandles(history).map((candle) => candle.time)).toEqual([1704758400, 1704758520])
    expect(toBidChartCandles(parseHistory({ ...response, bid: [], ask: [] }, range))).toEqual([])
  })

  it('rejects invalid or out-of-order candles', () => {
    expect(() => parseHistory({ ...response, bid: [{ ...bid, high: 1.0 }] }, range)).toThrow('invalid candle')
    expect(() => parseHistory({ ...response, bid: [bid, bid] }, range)).toThrow('invalid candle')
    expect(() => parseHistory({ ...response, ask: 'wrong' }, range)).toThrow('invalid candle list')
  })

  it('uses the backend UTC date limits', () => {
    expect(validateDateRange(range, '2024-01-11')).toBeNull()
    expect(validateDateRange({ from: '2024-01-01', to: '2024-04-02' }, '2024-04-03')).not.toBeNull()
    expect(validateDateRange({ from: '2024-01-09', to: '2024-01-12' }, '2024-01-11')).not.toBeNull()
    expect(validateDateRange({ from: '2024-02-30', to: '2024-03-01' }, '2024-03-02')).not.toBeNull()
  })

  it('requests the same-origin API and reports server failures', async () => {
    const mock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(response), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Provider unavailable' }), { status: 502 }))
    vi.stubGlobal('fetch', mock)
    await expect(fetchHistory(range)).resolves.toMatchObject({ bid: [bid], ask: [ask] })
    expect(mock.mock.calls[0][0]).toBe('/api/history?symbol=EURUSD&from=2024-01-09&to=2024-01-10')
    await expect(fetchHistory(range)).rejects.toThrow('Provider unavailable')
  })

  it('reports connectivity failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(fetchHistory(range)).rejects.toMatchObject({code:'BACKEND_NETWORK',title:'Backend connection unavailable'})
  })

  it('retains structured rate-limit advice through the same-origin API',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({code:'PROVIDER_RATE_LIMIT',title:'Provider rate limit reached',error:'Dukascopy has limited historical downloads.',action:'Wait before retrying.',retryAfterMs:12000}),{status:429})))
    await expect(fetchHistory(range)).rejects.toMatchObject({code:'PROVIDER_RATE_LIMIT',title:'Provider rate limit reached',retryAfterMs:12000})
  })
})
