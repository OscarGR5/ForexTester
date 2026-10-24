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
  return quote
}
export async function downloadHistory(quote: HistoryQuote, signal: AbortSignal): Promise<LoadedHistory> {
  const value = await call('/api/history/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quoteId: quote.id, confirm: true }), signal })
  return { ...parseHistory(value, quote), tradingFrom: quote.tradingFrom }
}
