import { completedObservations, journalSetups, netR, performanceStats, type Observation } from './analytics'
import type { EquityLedger, EquityPoint } from './equity'
import type { TradingState } from './trading'

// Every setup analysis uses this same ordering, including simultaneous exits.
export function completedSetups(state: TradingState) {
  return completedObservations(journalSetups(state))
    .sort((a, b) => a.exitTime - b.exitTime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function setupPerformance(observations: readonly Observation[], referenceBalance: number) {
  const stats = performanceStats(observations, referenceBalance)
  const winners: number[] = [], losers: number[] = []
  let streak = 0, maxLosingStreak = 0, invalidWinners = false, invalidLosers = false
  for (const item of observations) {
    const r = netR(item.netPnlUsd, item.initialRiskUsd)
    if (item.netPnlUsd > 0) { if (r === null) invalidWinners = true; else winners.push(r) }
    if (item.netPnlUsd < 0) { if (r === null) invalidLosers = true; else losers.push(r) }
    streak = item.netPnlUsd < 0 ? streak + 1 : 0
    maxLosingStreak = Math.max(maxLosingStreak, streak)
  }
  const average = (values: number[], invalid: boolean) => values.length && !invalid ? values.reduce((sum, r) => sum + r, 0) / values.length : null
  // A total with a missing denominator is unknown, rather than a partial sum.
  const allRisksValid = stats.validRCount === stats.count
  return { ...stats, totalNetR: allRisksValid ? stats.totalNetR : null, averageNetR: allRisksValid ? stats.averageNetR : null,
    averageWinnerR: average(winners, invalidWinners), averageLoserR: average(losers, invalidLosers),
    largestWinnerR: winners.length && !invalidWinners ? winners.reduce((a, b) => Math.max(a, b)) : null,
    largestLoserR: losers.length && !invalidLosers ? losers.reduce((a, b) => Math.min(a, b)) : null,
    maxLosingStreak: stats.count ? maxLosingStreak : null }
}

export function returnPercent(equity: number | null | undefined, referenceBalance: number): number | null {
  if (equity == null || !Number.isFinite(equity) || !Number.isFinite(referenceBalance) || referenceBalance <= 0) return null
  const percent = (equity - referenceBalance) / referenceBalance * 100
  return Number.isFinite(percent) ? percent : null
}

export function startingDeficit(point: EquityPoint, referenceBalance: number) {
  const percent = returnPercent(point.equityUsd, referenceBalance)
  return percent === null ? null : Math.max(0, -percent)
}

// Full-resolution linked ledger, independent of display sampling and setup exits.
export function equityPerformance(ledger: EquityLedger, referenceBalance: number) {
  let maxStartingDeficitUsd: number | null = null, startingPoint: EquityPoint | null = null, peakPoint: EquityPoint | null = null
  for (let node = ledger.tail; node; node = node.previous) {
    const point = node.point
    if (point.equityUsd === null || !Number.isFinite(point.equityUsd)) continue
    const deficit = Math.max(0, referenceBalance - point.equityUsd)
    if (maxStartingDeficitUsd === null || deficit >= maxStartingDeficitUsd) {
      maxStartingDeficitUsd = deficit; startingPoint = point
    }
    if (point.drawdownPercent !== null && (peakPoint === null || point.drawdownPercent >= peakPoint.drawdownPercent!)) peakPoint = point
  }
  const currentEquityUsd = ledger.tail?.point.equityUsd ?? null
  const validReference = Number.isFinite(referenceBalance) && referenceBalance > 0
  return { currentEquityUsd, netReturnPercent: returnPercent(currentEquityUsd, referenceBalance),
    netReturnUsd: currentEquityUsd === null ? null : currentEquityUsd - referenceBalance,
    maxStartingDeficitUsd, maxStartingDeficitPercent: maxStartingDeficitUsd === null || !validReference ? null : maxStartingDeficitUsd / referenceBalance * 100,
    startingPoint, peakPoint,
    maxPeakDrawdownPercent: peakPoint === null || !validReference ? null : ledger.maxDrawdownPercent }
}

export function monthlyPerformance(observations: readonly Observation[], referenceBalance: number, start: number, endpoint: number | null) {
  if (!Number.isFinite(start) || endpoint === null || !Number.isFinite(endpoint) || endpoint < start) return []
  const first = new Date(start), last = new Date(endpoint)
  const buckets = new Map<string, Observation[]>()
  for (let month = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1), end = Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), 1); month <= end;) {
    const date = new Date(month)
    buckets.set(date.toISOString().slice(0, 7), [])
    month = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
  }
  for (const item of observations) {
    if (item.exitTime >= start && item.exitTime <= endpoint) buckets.get(new Date(item.exitTime).toISOString().slice(0, 7))?.push(item)
  }
  return [...buckets].map(([month, values]) => ({ month, ...performanceStats(values, referenceBalance) }))
}
