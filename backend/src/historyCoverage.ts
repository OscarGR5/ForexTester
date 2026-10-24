import { instrumentMetaData } from 'dukascopy-node'
import type { HistoryResponse } from './history.js'

export function historyCoverage(now = new Date()) {
  const first = new Date(instrumentMetaData.eurusd.startDayForMinuteCandles).toISOString()
  const today = Date.parse(now.toISOString().slice(0, 10))
  return { symbol: 'EURUSD', resolution: 'M1', providerEarliestTimestamp: first,
    earliestSelectableDate: first.slice(0, 10), latestEligibleDate: new Date(today - 86400000).toISOString().slice(0, 10),
    latestBoundaryProvisional: true, maximumCalendarDays: 90, timezone: 'UTC' }
}
export function verifiedDate(history: HistoryResponse): string | null {
  const asks = new Set(history.ask.map(b => b.timestamp))
  const latest = [...history.bid].reverse().find(b => asks.has(b.timestamp))
  return latest ? new Date(latest.timestamp).toISOString().slice(0, 10) : null
}
function errorChain(error: unknown): Record<string, unknown>[] {
  const chain: Record<string, unknown>[] = []
  while (error && typeof error === 'object' && !chain.includes(error as Record<string, unknown>) && chain.length < 5) {
    chain.push(error as Record<string, unknown>)
    error = (error as { cause?: unknown }).cause
  }
  return chain
}

// An allowlist, not a dump of the upstream Error: causes can carry request
// headers, cookies and challenge data. Keep only facts needed to diagnose access.
export function historyErrorDetails(error: unknown) {
  return errorChain(error).map(item => {
    const message = typeof item.message === 'string' ? item.message : ''
    const status = Number(item.status ?? message.match(/(?:last HTTP status: |HTTP |status )(\d{3})/)?.[1])
    const names = ['Error', 'TypeError', 'TimeoutError', 'WafTokenError', 'WafChallengeError', 'RateLimitError', 'HistoryProviderError']
    const codes = ['DUKASCOPY_WAF_TOKEN', 'DUKASCOPY_WAF_CHALLENGE', 'DUKASCOPY_RATE_LIMIT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN']
    return { name: names.includes(String(item.name)) ? String(item.name) : 'OtherError',
      ...(codes.includes(String(item.code)) ? { code: String(item.code) } : {}),
      ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
      ...(/WAF action: (challenge|captcha|none)/.test(message) ? { wafAction: message.match(/WAF action: (challenge|captcha|none)/)![1] } : {}),
      ...(item.priceType === 'bid' || item.priceType === 'ask' ? { priceType: item.priceType } : {}) }
  })
}

export function classifyHistoryError(error: unknown): { code: string; title: string; error: string; action: string; retryAfterMs?: number } {
  const chain = errorChain(error)
  const message = chain.map(item => typeof item.message === 'string' ? item.message : '').join('\n')
  const details = historyErrorDetails(error)
  const codes = details.map(item => item.code)
  const names = details.map(item => item.name)
  const statuses = details.map(item => item.status)
  if (/system dependencies are missing|Host system is missing dependencies|error while loading shared libraries|lib[^ ]+\.so.*not found/i.test(message))
    return { code: 'BROWSER_DEPENDENCIES', title: 'Browser libraries missing', error: 'Historical data is unavailable because Linux browser libraries are missing.', action: 'Ask your system administrator to review npx dukascopy-node --install-browser --with-deps, then restart the backend.' }
  if (/Could not launch|executable.*(exist|found)|browser.*(unavailable|launch)|sandbox/i.test(message))
    return { code: 'BROWSER_UNAVAILABLE', title: 'Provider browser unavailable', error: "Historical data is unavailable because the data provider's browser component could not start.", action: 'Run npx dukascopy-node --install-browser in the project directory, or configure DUKASCOPY_CHROME_PATH. See README browser troubleshooting.' }
  if (codes.includes('DUKASCOPY_RATE_LIMIT') || names.includes('RateLimitError') || statuses.includes(429)) {
    const retryAfter = chain.map(item => item.retryAfterMs).find(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) as number | undefined
    return { code: 'PROVIDER_RATE_LIMIT', title: 'Provider rate limit reached', error: 'Dukascopy has limited historical downloads.', action: 'Wait before retrying. Completed chunks remain cached where valid.', ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}) }
  }
  if (statuses.some(status => status === 500 || status === 502 || status === 503 || status === 504))
    return { code: 'PROVIDER_UNAVAILABLE', title: 'Provider temporarily unavailable', error: 'Dukascopy returned a temporary server error.', action: 'Retry later. Completed chunks remain cached where valid.' }
  if (codes.some(code => code && /ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/.test(code)))
    return { code: 'PROVIDER_NETWORK', title: 'Provider connection unavailable', error: 'The historical data provider could not be reached.', action: 'Check the network connection and retry.' }
  if (codes.some(code => code?.startsWith('DUKASCOPY_WAF_')) || names.includes('WafTokenError') || names.includes('WafChallengeError'))
    return { code: 'PROVIDER_WAF', title: 'Provider authorization unavailable', error: 'Dukascopy could not authorize this historical download. The selected period was not loaded.', action: 'Retry later. Previously downloaded chunks remain cached where valid.' }
  if (statuses.includes(403))
    return { code: 'PROVIDER_DENIED', title: 'Provider access denied', error: 'Dukascopy denied access to this historical download.', action: 'Retry later or check provider access. Completed chunks remain cached where valid.' }
  if (/fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|network|socket|timed? ?out/i.test(message))
    return { code: 'PROVIDER_NETWORK', title: 'Provider connection unavailable', error: 'The historical data provider could not be reached.', action: 'Check the network connection and retry.' }
  return { code: 'HISTORY_UNAVAILABLE', title: 'Historical data unavailable', error: 'Historical data is temporarily unavailable.', action: 'Retry the interval later or select an earlier completed UTC period.' }
}
