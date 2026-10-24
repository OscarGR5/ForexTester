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
export function classifyHistoryError(error: unknown) {
  const name = error instanceof Error ? error.name : ''
  const message = error instanceof Error ? error.message : String(error)
  if (/system dependencies are missing|Host system is missing dependencies|error while loading shared libraries|lib[^ ]+\.so.*not found/i.test(message))
    return { code: 'BROWSER_DEPENDENCIES', error: 'Historical data is unavailable because Linux browser libraries are missing.', action: 'Ask your system administrator to review npx dukascopy-node --install-browser --with-deps, then restart the backend.' }
  if (/Could not launch|executable.*(exist|found)|browser.*(unavailable|launch)|sandbox/i.test(message))
    return { code: 'BROWSER_UNAVAILABLE', error: "Historical data is unavailable because the data provider's browser component could not start.", action: 'Run npx dukascopy-node --install-browser in the project directory, or configure DUKASCOPY_CHROME_PATH. See README browser troubleshooting.' }
  if (/Waf|Token|Challenge/i.test(name) || /WAF|token acquisition/i.test(message))
    return { code: 'PROVIDER_WAF', error: 'The data provider could not authorize this historical request.', action: 'Retry later. Check provider access and the backend diagnostics; do not bypass access protections.' }
  if (/fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|network|socket|timeout/i.test(message))
    return { code: 'PROVIDER_NETWORK', error: 'The historical data provider could not be reached.', action: 'Check the network connection and retry.' }
  return { code: 'HISTORY_UNAVAILABLE', error: 'Historical data is temporarily unavailable.', action: 'Retry the interval later or select an earlier completed UTC period.' }
}
