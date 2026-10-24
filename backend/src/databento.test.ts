import { expect, it, vi } from 'vitest'
import { DatabentoClient, decodeJsonLines } from './databento.js'
const contracts = [{ from: '2024-01-09', to: '2024-01-11', instrumentId: 156627, rawSymbol: '6EH4' }]
const record = { hd: { ts_event: '2024-01-09T00:00:00.000000000Z', rtype: 33, publisher_id: 1, instrument_id: 156627 }, open: '1.094970000', high: '1.095040000', low: '1.094920000', close: '1.095010000', volume: '123456789012345678' }
const decode = (items: unknown[]) => decodeJsonLines(items.map(i => JSON.stringify(i)).join('\n'), '2024-01-09', '2024-01-11', contracts)
it('decodes nested JSON headers, full decimal prices, uint64 volume and UTC interval starts', () => {
  const history = decode([record, { ...record, hd: { ...record.hd, ts_event: '2024-01-09T00:03:00Z' } }])
  expect(history.candles[0]).toEqual({ timestamp: Date.parse('2024-01-09'), open: 1.09497, high: 1.09504, low: 1.09492, close: 1.09501, volume: '123456789012345678', instrumentId: 156627 })
  expect(history.candles).toHaveLength(2) // No candles invented for missing minutes.
})
it.each([
  { open: '1094970000' }, { low: '0.000000000' }, { high: '1.000000000' }, { volume: '-1' }, { volume: '0' }, { volume: '18446744073709551616' },
  { hd: { ...record.hd, ts_event: '2024-01-09T00:00:01Z' } }, { hd: { ...record.hd, instrument_id: 999 } }, { hd: { ...record.hd, rtype: 34 } }, { hd: { ...record.hd, publisher_id: 2 } },
])('rejects malformed price, volume, timestamp, schema or instrument identity', change => { expect(() => decode([{ ...record, ...change }])).toThrow() })
it('rejects identical/conflicting duplicates and out-of-order records', () => {
  expect(() => decode([record, record])).toThrow()
  expect(() => decode([record, { ...record, close: '1.095000000' }])).toThrow()
  expect(() => decode([{ ...record, hd: { ...record.hd, ts_event: '2024-01-09T00:03:00Z' } }, record])).toThrow()
})
it('uses documented endpoints, server-only Basic auth and bounded pretty-price JSON with no retries', async () => {
  const http = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(record) + '\n'))
  const client = new DatabentoClient('fixture-key', http)
  await client.download('2024-01-09', '2024-01-11', contracts)
  const [url, options] = http.mock.calls[0]
  expect(url).toBe('https://hist.databento.com/v0/timeseries.get_range')
  expect(options?.redirect).toBe('error')
  const params = new URLSearchParams(String(options?.body))
  expect(Object.fromEntries(params)).toMatchObject({ dataset: 'GLBX.MDP3', symbols: '6E.v.0', schema: 'ohlcv-1m', stype_in: 'continuous', encoding: 'json', pretty_px: 'true', pretty_ts: 'true', compression: 'none' })
  expect(String(url)).not.toContain('fixture-key')
  http.mockResolvedValue(new Response('secret fixture-key must not escape', { status: 403 }))
  await expect(client.cost('2024-01-09', '2024-01-11')).rejects.toMatchObject({ code: 'DATABENTO_ACCESS', message: expect.not.stringContaining('fixture-key') })
  expect(http).toHaveBeenCalledTimes(2)
})
it('rejects unestablished costs and clips verified weekend mapping bounds without extrapolating', async () => {
  const mapping = (key: string, symbol: string) => ({ status: 0, partial: [], not_found: [], result: { [key]: [{ d0: '2024-01-05', d1: '2024-01-09', s: symbol }] } })
  const http = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify(mapping('6E.v.0', '156627')))).mockResolvedValueOnce(new Response(JSON.stringify(mapping('156627', '6EH4'))))
  const client = new DatabentoClient('fixture-key', http)
  expect(await client.contracts('2024-01-06', '2024-01-09')).toEqual([{ from: '2024-01-06', to: '2024-01-09', instrumentId: 156627, rawSymbol: '6EH4' }])
  for (const value of ['NaN', 'null', '"0.02"', '-1']) {
    http.mockResolvedValueOnce(new Response(value))
    await expect(client.cost('2024-01-06', '2024-01-09')).rejects.toThrow()
  }
})
