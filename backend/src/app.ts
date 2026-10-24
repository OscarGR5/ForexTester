import { createServer, type Server } from 'node:http'
import { SessionStorage } from './sessionStorage.js'
import { readJson, sessionApi } from './sessionApi.js'
import { HistoryService } from './history.js'
import { DataError, day } from './databento.js'

export function createApp(history = new HistoryService(), now: () => Date = () => new Date(), storage = new SessionStorage()): Server {
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
      if (request.method === 'GET' && url.pathname === '/api/history/coverage') {
        const cached = await history.cachedBounds()
        if (cached) {
          response.end(JSON.stringify({ symbol: '6E', resolution: 'M1', source: 'Databento', cachedFrom: cached.from, cachedTo: cached.to, cachedDates: cached.cachedDates,
            providerEarliestTimestamp: cached.from + 'T00:00:00Z', earliestSelectableDate: day(Date.parse(cached.from) + 30 * 86400000),
            latestEligibleDate: day(now().getTime() - 86400000), maximumCalendarDays: 90, latestBoundaryProvisional: false,
            lastVerifiedAvailableDate: null, providerHealth: { status: 'cache-validated' }, timezone: 'UTC' })); return
        }
        const range = await history.client.availability()
        const startDay = Date.parse(range.start) > Date.parse(range.start.slice(0, 10)) ? Date.parse(range.start.slice(0, 10)) + 86400000 : Date.parse(range.start.slice(0, 10))
        const end = Math.min(Date.parse(range.end.slice(0, 10)), Date.parse(day(now().getTime())))
        response.end(JSON.stringify({ symbol: '6E', resolution: 'M1', source: 'Databento', providerEarliestTimestamp: range.start,
          earliestSelectableDate: day(startDay + 30 * 86400000), latestEligibleDate: day(end - 86400000), maximumCalendarDays: 90,
          latestBoundaryProvisional: false, lastVerifiedAvailableDate: null, providerHealth: { status: 'metadata-verified' }, timezone: 'UTC' })); return
      }
      if (request.method === 'GET' && ['/api/history', '/api/history/estimate'].includes(url.pathname)) {
        if (url.searchParams.get('symbol') !== '6E') throw new DataError('LEGACY_DATASET_REQUIRED', 'Legacy sessions require their original stored provider dataset. Databento cannot regenerate or substitute it.', 409)
        const from = url.searchParams.get('from') ?? '', to = url.searchParams.get('to') ?? ''
        const result = url.pathname.endsWith('/estimate') ? await history.estimate(from, to) : await history.readCached(from, to)
        response.end(JSON.stringify(result)); return
      }
      if (request.method === 'POST' && url.pathname === '/api/history/download') {
        if (origin !== `http://${host}`) throw new DataError('LOCAL_ACCESS_REQUIRED', 'Same-origin Origin header required for spending confirmation.', 403)
        const body = await readJson(request, 4096)
        if (typeof body.quoteId !== 'string') throw new DataError('INVALID_QUOTE', 'A current quote is required.')
        const result = await history.confirm(body.quoteId, body.confirm === true)
        response.end(JSON.stringify(result)); return
      }
      response.writeHead(404); response.end(JSON.stringify({ error: 'Not found' }))
    } catch (error) {
      // Never log upstream errors, request bodies, headers, or credentials.
      const diagnostic = error instanceof DataError ? error : new DataError('HISTORY_FAILURE', 'Historical operation failed. Check local cache access and backend configuration. No automatic retry.', 503)
      response.writeHead(diagnostic.status)
      response.end(JSON.stringify({ code: diagnostic.code, title: diagnostic.code === 'DATABENTO_CONFIGURATION' ? 'Databento configuration required' : 'Historical data unavailable', error: diagnostic.message }))
    }
  })
  server.on('close', () => { void storage.close().catch(() => {}) })
  return server
}
