import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import type { Server } from 'node:http'
import type { JsonItem } from 'dukascopy-node'
import { createApp } from './app.js'
import type { RatesFetcher } from './history.js'

let cache: string
beforeEach(async () => { cache = await mkdtemp(join(tmpdir(), 'forextester-cache-test-')); vi.stubEnv('FOREXTESTER_CACHE_DIR', cache) })
let server: Server | undefined
const now = () => new Date('2024-01-20T12:00:00.000Z')
const candle = (timestamp: number, open: number): JsonItem => ({
  timestamp, open, high: open + 0.0002, low: open - 0.0002, close: open + 0.0001,
})

async function request(path: string, fetchRates?: RatesFetcher) {
  server = createApp(fetchRates, now).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing server address')
  return fetch(`http://127.0.0.1:${address.port}${path}`)
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = undefined
  vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(cache, { recursive: true, force: true })
})

describe('health endpoint', () => {
  it('returns JSON status', async () => {
    const response = await request('/api/health')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({ status: 'ok' })
  })
})

describe('history endpoint', () => {
  const path = '/api/history?symbol=EURUSD&from=2024-01-09&to=2024-01-10'
  const first = Date.parse('2024-01-09T00:00:00.000Z')
  const second = first + 60_000

  it('returns separate, ordered bid and ask M1 candles with UTC millisecond timestamps', async () => {
    vi.stubEnv('DUKASCOPY_CHROME_PATH', '/test/chromium')
    const fetchRates = vi.fn(async (config: Parameters<RatesFetcher>[0]) =>
      config.priceType === 'bid'
        ? [candle(second, 1.1), candle(first, 1.09), candle(first, 1.09)]
        : [candle(first, 1.091), candle(second, 1.101)])

    const response = await request(path, fetchRates)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      symbol: 'EURUSD', resolution: 'M1', from: '2024-01-09', to: '2024-01-10',
      bid: [candle(first, 1.09), candle(second, 1.1)],
      ask: [candle(first, 1.091), candle(second, 1.101)],
    })
    expect(fetchRates).toHaveBeenCalledTimes(2)
    expect(fetchRates.mock.calls.map(([config]) => config.priceType)).toEqual(['bid', 'ask'])
    for (const [config] of fetchRates.mock.calls) {
      expect(config).toMatchObject({ instrument: 'eurusd', timeframe: 'm1', format: 'json', utcOffset: 0, useCache: true })
      expect(config.cacheFolderPath).toBe(join(cache, 'dukascopy') + '/')
      expect(config.wafTokenCachePath).toBe(join(cache, 'dukascopy/waf-token.json'))
      expect(config.retryCount).toBe(2)
      expect(config.chromePath).toMatch(process.platform === 'linux' ? /scripts\/provider-browser\.sh$/ : /\/test\/chromium$/)
      expect(config.dates).toEqual({ from: new Date('2024-01-09T00:00:00.000Z'), to: new Date('2024-01-10T00:00:00.000Z') })
    }
  })

  it.each([
    '/api/history?symbol=GBPUSD&from=2024-01-09&to=2024-01-10',
    '/api/history?from=2024-01-09&to=2024-01-10',
    '/api/history?symbol=EURUSD&from=2024-02-30&to=2024-03-01',
    '/api/history?symbol=EURUSD&from=2024-01-09T00:00:00Z&to=2024-01-10',
    '/api/history?symbol=EURUSD&from=2024-01-10&to=2024-01-09',
    '/api/history?symbol=EURUSD&from=2024-01-09&to=2024-01-09',
    '/api/history?symbol=EURUSD&from=2024-01-09&to=2024-01-21',
    '/api/history?symbol=EURUSD&from=2024-01-19&to=2024-01-21',
    '/api/history?symbol=EURUSD&from=2024-01-09&to=2024-01-20',
  ])('rejects invalid request %s without contacting the provider', async (invalidPath) => {
    const fetchRates = vi.fn(async () => [])
    const response = await request(invalidPath, fetchRates)
    expect(response.status).toBe(400)
    expect(await response.json()).toHaveProperty('error')
    expect(fetchRates).not.toHaveBeenCalled()
  })

  it('returns empty arrays when the provider has no candles', async () => {
    const response = await request(path, async () => [])
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ symbol: 'EURUSD', resolution: 'M1', from: '2024-01-09', to: '2024-01-10', bid: [], ask: [] })
  })

  it('does not copy bid candles into an empty ask response', async () => {
    const response = await request(path, async (config) => config.priceType === 'bid' ? [candle(first, 1.09)] : [])
    const body = await response.json() as { bid: JsonItem[]; ask: JsonItem[] }
    expect(body.bid).toEqual([candle(first, 1.09)])
    expect(body.ask).toEqual([])
  })

  it('keeps genuine gaps and does not synthesize a missing minute', async () => {
    const response = await request(path, async () => [candle(first, 1.09), candle(first + 120_000, 1.1)])
    const body = await response.json() as { bid: JsonItem[] }
    expect(body.bid.map((item) => item.timestamp)).toEqual([first, first + 120_000])
  })

  it('hides upstream failures from API consumers', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await request(path, async () => { throw new Error('secret upstream detail') })
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: 'Historical data is temporarily unavailable.', code: 'HISTORY_UNAVAILABLE' })
  })

  it('rejects conflicting duplicate candles', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await request(path, async () => [candle(first, 1.09), candle(first, 1.1)])
    expect(response.status).toBe(502)
  })

  it('rejects malformed prices', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await request(path, async () => [{ ...candle(first, 1.09), high: 1.0 }])
    expect(response.status).toBe(502)
  })
})
