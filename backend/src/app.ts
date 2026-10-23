import { createServer, type Server } from 'node:http'
import { SessionStorage } from './sessionStorage.js'
import { sessionApi } from './sessionApi.js'
import { loadHistory, type RatesFetcher } from './history.js'

const MAX_HISTORY_DAYS = 7 // Per-chunk provider safety limit; the frontend coordinates longer intervals.

function parseUtcDate(value: string | null): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const timestamp = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
    ? timestamp
    : null
}

export function createApp(fetchRates?: RatesFetcher, now: () => Date = () => new Date(), storage = new SessionStorage()): Server {
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8')

    if (await sessionApi(request, response, storage)) return

    if (request.method === 'GET' && request.url === '/api/health') {
      response.writeHead(200)
      response.end(JSON.stringify({ status: 'ok' }))
      return
    }

    const url = new URL(request.url ?? '/', 'http://localhost')
    if (request.method === 'GET' && url.pathname === '/api/history') {
      const symbol = url.searchParams.get('symbol')
      const from = url.searchParams.get('from')
      const to = url.searchParams.get('to')
      const fromMs = parseUtcDate(from)
      const toMs = parseUtcDate(to)
      const todayUtc = Date.parse(`${now().toISOString().slice(0, 10)}T00:00:00.000Z`)

      if (symbol !== 'EURUSD' || fromMs === null || toMs === null || fromMs >= toMs ||
        toMs > todayUtc || (toMs - fromMs) / 86_400_000 > MAX_HISTORY_DAYS) {
        response.writeHead(400)
        response.end(JSON.stringify({ error: 'Use symbol=EURUSD and a valid completed UTC date range of 1 to 7 days (from inclusive, to exclusive).' }))
        return
      }

      try {
        const history = await loadHistory(from!, to!, fetchRates)
        response.writeHead(200)
        response.end(JSON.stringify(history))
      } catch (error) {
        console.error('Historical data retrieval failed:', error)
        response.writeHead(502)
        response.end(JSON.stringify({ error: 'Historical data is temporarily unavailable.' }))
      }
      return
    }

    response.writeHead(404)
    response.end(JSON.stringify({ error: 'Not found' }))
  })
  server.on('close', () => { void storage.close().catch(() => {}) })
  return server
}
