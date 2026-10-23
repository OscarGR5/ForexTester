import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchHistory, parseHistory, toBidChartCandles, validateDateRange } from './history'

const range = { from: '2024-01-09', to: '2024-01-10' }
const bid = { timestamp: 1704758400000, open: 1.09497, high: 1.09504, low: 1.09492, close: 1.09501 }
const ask = { timestamp: 1704758400000, open: 1.09499, high: 1.09509, low: 1.09496, close: 1.09504 }
const response = { symbol: 'EURUSD', resolution: 'M1', ...range, bid: [bid], ask: [ask] }

afterEach(() => vi.unstubAllGlobals())

describe('historical chart data', () => {
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
    expect(validateDateRange({ from: '2024-01-01', to: '2024-01-09' }, '2024-01-11')).not.toBeNull()
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
    await expect(fetchHistory(range)).rejects.toThrow('Failed to fetch')
  })
})
