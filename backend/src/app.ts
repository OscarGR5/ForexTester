import { createServer, type Server } from 'node:http'
import { SessionStorage } from './sessionStorage.js'
import { sessionApi } from './sessionApi.js'
import { LocalArchive, DataError } from './localArchive.js'

export function createApp(history = new LocalArchive(), _now: () => Date = () => new Date(), storage = new SessionStorage()): Server {
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    if (await sessionApi(request, response, storage)) return
    const url = new URL(request.url ?? '/', 'http://localhost')
    try {
      const host = request.headers.host, origin = request.headers.origin
      if (!host || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) || origin && origin !== `http://${host}` || request.headers['sec-fetch-site'] === 'cross-site') throw new DataError('LOCAL_ACCESS_REQUIRED', 'Same-origin localhost access required.', 403)
      if (request.method === 'GET' && url.pathname === '/api/health') { response.end(JSON.stringify({ status: 'ok' })); return }
      if (request.method === 'GET' && url.pathname === '/api/history/datasets') { response.end(JSON.stringify({ datasets: await history.datasets() })); return }
      if (request.method === 'GET' && url.pathname === '/api/history/calendar') { response.end(JSON.stringify(await history.calendar(url.searchParams.get('symbol') ?? 'EURUSD'))); return }
      if (request.method === 'GET' && url.pathname === '/api/history/coverage') { response.end(JSON.stringify({ datasets: await history.datasets() })); return }
      if (request.method === 'GET' && url.pathname === '/api/history') {
        if ([...url.searchParams.keys()].some(key => !['symbol','from','to','tradingFrom'].includes(key))) throw new DataError('INVALID_HISTORY_REQUEST', 'Only an installed symbol and UTC dates are accepted.')
        const from = url.searchParams.get('from') ?? '', tradingFrom = url.searchParams.get('tradingFrom') ?? ''
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || Date.parse(tradingFrom) - Date.parse(from) !== 30 * 86400000) throw new DataError('INVALID_HISTORY_RANGE', 'A 30-day pre-roll is required.')
        response.end(JSON.stringify(await history.load(url.searchParams.get('symbol') ?? '', tradingFrom, url.searchParams.get('to') ?? ''))); return
      }
      response.writeHead(404); response.end(JSON.stringify({ error: 'Not found' }))
    } catch (error) {
      const diagnostic = error instanceof DataError ? error : new DataError('HISTORY_FAILURE', 'Local historical data could not be read. Check installed data and filesystem permissions.', 503)
      response.writeHead(diagnostic.status)
      response.end(JSON.stringify({ code: diagnostic.code, title: 'Historical data unavailable', error: diagnostic.message }))
    }
  })
  server.on('close', () => { void storage.close().catch(() => {}) })
  return server
}
