import { validateDateRange } from './history'
import type { EquityLedger } from './equity'
export interface Coverage {
  symbol: string; resolution: string; providerEarliestTimestamp: string; earliestSelectableDate: string;
  latestEligibleDate: string; latestBoundaryProvisional: boolean; lastVerifiedAvailableDate: string | null;
  cachedFrom?: string; cachedTo?: string; cachedDates?: number;
  providerHealth: { status: string; error?: string; action?: string }
}
export function shiftDate(value: string, days: number): string {
  const ms = Date.parse(value)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) return ''
  return Number.isFinite(ms) ? new Date(ms + days * 86400000).toISOString().slice(0, 10) : ''
}
export function selectedRange(from: string, through: string, coverage: Coverage | null) {
  const range = { from, to: shiftDate(through, 1) }
  const invalid = coverage?.providerHealth.status === 'metadata-verified' && (from < coverage.earliestSelectableDate || through > coverage.latestEligibleDate) ? 'Choose dates inside the advertised historical boundaries.'
    : validateDateRange(range, coverage ? shiftDate(coverage.latestEligibleDate, 1) : undefined)
  return { range, error: invalid ? 'Choose 1 to 90 completed UTC calendar days within the historical boundaries. ' + invalid : null,
    days: Math.max(0, (Date.parse(range.to) - Date.parse(from)) / 86400000) }
}
export function accountPnl(ledger: EquityLedger, reference: number) {
  const equity = ledger.tail?.point.equityUsd
  if (equity === null || equity === undefined) return null
  return { usd: equity - reference, percent: (equity - reference) / reference * 100 }
}
