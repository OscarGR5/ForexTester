import { createServer, type Server } from 'node:http'
import { SessionStorage } from './sessionStorage.js'
import { sessionApi } from './sessionApi.js'
import { loadHistory, type RatesFetcher } from './history.js'

import { historyCoverage, classifyHistoryError, historyErrorDetails, verifiedDate } from './historyCoverage.js'

import { FxcmHistory } from './fxcm.js'
import { NORMALIZATION_VERSION, type HistoryProvider } from '../../frontend/src/history.js'

const MAX_HISTORY_DAYS = 7 // Per-chunk provider safety limit; the frontend coordinates longer intervals.

function parseUtcDate(value: string | null): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const timestamp = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
    ? timestamp
    : null
}

export function createApp(fetchRates?: RatesFetcher, now: () => Date = () => new Date(), storage = new SessionStorage(), fxcm = new FxcmHistory(fetch, now)): Server {
  const health: Record<HistoryProvider, { providerHealth: { status: string; code?: string; error?: string; action?: string }; lastVerifiedAvailableDate: string | null }> = { dukascopy: { providerHealth: { status: 'unknown' }, lastVerifiedAvailableDate: null }, fxcm: { providerHealth: { status: 'unknown' }, lastVerifiedAvailableDate: null } }
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8')

    if (await sessionApi(request, response, storage)) return

    if (request.method === 'GET' && request.url === '/api/health') {
      response.writeHead(200)
      response.end(JSON.stringify({ status: 'ok' }))
      return
    }

    const url = new URL(request.url ?? '/', 'http://localhost')
    const selectedProvider = url.searchParams.get('provider')
    if (url.pathname.startsWith('/api/history') && selectedProvider !== null && !['dukascopy', 'fxcm'].includes(selectedProvider)) {
      response.writeHead(400); response.end(JSON.stringify({ code: 'UNKNOWN_PROVIDER', error: 'Select dukascopy or fxcm.' })); return
    }
    const provider = (selectedProvider ?? 'dukascopy') as HistoryProvider
    const state = health[provider]
    if (request.method === 'GET' && url.pathname === '/api/history/coverage') {
      response.end(JSON.stringify({ ...historyCoverage(now(), provider), ...state }))
      return
    }
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
        response.end(JSON.stringify({ code: 'INVALID_HISTORY_RANGE', title: 'Invalid historical date range', error: 'Use symbol=EURUSD and a valid completed UTC date range of 1 to 7 days (from inclusive, to exclusive).' }))
        return
      }

      try {
        const history = provider === 'fxcm' ? await fxcm.load(from!, to!) : await loadHistory(from!, to!, fetchRates)
        if (selectedProvider && provider === 'dukascopy') history.provenance = { version: 2, provider, normalizationVersion: NORMALIZATION_VERSION }
        const verified = verifiedDate(history)
        if (verified && (!state.lastVerifiedAvailableDate || verified > state.lastVerifiedAvailableDate)) state.lastVerifiedAvailableDate = verified
        state.providerHealth = { status: verified ? 'ready' : 'no-observations' }
        response.writeHead(200)
        response.end(JSON.stringify(history))
      } catch (error) {
        const diagnostic = classifyHistoryError(error)
        console.error('Historical data retrieval failed:', { from, to, code: diagnostic.code, causes: historyErrorDetails(error) })
        if (diagnostic.retryAfterMs !== undefined) response.setHeader('Retry-After', String(Math.ceil(diagnostic.retryAfterMs / 1000)))
        response.writeHead(diagnostic.code === 'PROVIDER_RATE_LIMIT' ? 429 : 502)
        state.providerHealth = { status: 'error', ...diagnostic }
        response.end(JSON.stringify(diagnostic))
      }
      return
    }

    response.writeHead(404)
    response.end(JSON.stringify({ error: 'Not found' }))
  })
  server.on('close', () => { void storage.close().catch(() => {}) })
  return server
}
