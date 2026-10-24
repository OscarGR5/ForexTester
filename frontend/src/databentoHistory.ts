import { HistoryRequestError, parseHistory, type DateRange } from './history'
import type { LoadedHistory } from './historyLoader'
export interface HistoryQuote extends DateRange {
  id: string; tradingFrom: string; cached: boolean; estimatedUsd: number; reservedUsd: number; remainingBudgetUsd: number
  downloadAllowed: boolean; blockedReason: string | null; expiresAt: string; missingRanges: DateRange[]
}
async function call(path: string, init?: RequestInit) {
  let response: Response
  try { response = await fetch(path, init) }
  catch { throw new HistoryRequestError('The backend could not be reached. Check its connection and retry explicitly.', 'BACKEND_NETWORK') }
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new HistoryRequestError(body?.error ?? 'Historical request failed.', body?.code ?? 'HISTORY_UNAVAILABLE', body?.title)
  return body
}
export async function quoteHistory(range: DateRange, signal: AbortSignal): Promise<HistoryQuote> {
  const quote = await call(`/api/history/estimate?${new URLSearchParams({ symbol: '6E', ...range })}`, { signal }) as HistoryQuote
  if (!quote || typeof quote.id !== 'string' || !Number.isFinite(quote.estimatedUsd) || quote.estimatedUsd < 0 || !Number.isFinite(quote.reservedUsd) ||
    quote.reservedUsd < quote.estimatedUsd || typeof quote.cached !== 'boolean' || typeof quote.downloadAllowed !== 'boolean' || quote.tradingFrom !== range.from || quote.to !== range.to) throw new Error('Invalid historical cost estimate.')
  const validDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
  if (!validDate(quote.from) || !validDate(quote.to) || quote.from >= quote.to || !Number.isFinite(quote.remainingBudgetUsd) || quote.remainingBudgetUsd < 0 ||
    !Number.isFinite(Date.parse(quote.expiresAt)) || !Array.isArray(quote.missingRanges) || quote.cached !== (quote.missingRanges.length === 0) ||
    quote.missingRanges.some((r, i) => !validDate(r.from) || !validDate(r.to) || r.from >= r.to || r.from < quote.from || r.to > quote.to || i > 0 && r.from < quote.missingRanges[i - 1].to)) throw new Error('Invalid historical cost estimate.')
  return quote
}
export async function downloadHistory(quote: HistoryQuote, signal: AbortSignal): Promise<LoadedHistory> {
  const value = await call('/api/history/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quoteId: quote.id, confirm: true }), signal })
  return { ...parseHistory(value, quote), tradingFrom: quote.tradingFrom }
}
