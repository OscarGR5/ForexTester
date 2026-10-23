import { type SetupStatus, type ClosedTrade, type Position, type TradingSetup, type TradingState } from './trading'

export type AnalyticsScope = 'setups' | 'positions'
export interface Observation {
  id: string
  entryTime: number
  exitTime: number
  grossPnlUsd: number
  totalCommissionUsd: number
  netPnlUsd: number
  initialRiskUsd: number
}

export function netR(netPnlUsd: number, originalRiskUsd: number): number | null {
  if (!Number.isFinite(netPnlUsd) || !Number.isFinite(originalRiskUsd) || originalRiskUsd <= 0) return null
  const result = netPnlUsd / originalRiskUsd
  return Number.isFinite(result) ? result : null
}

export function journalSetups(state: TradingState) {
  const groups = new Map(state.setups.map((setup) => [setup.id, {
    setup, positions: [] as Position[], closed: [] as ClosedTrade[], pendingCount: 0,
  }]))
  for (const entry of state.pending) {
    const group = groups.get(entry.setupId)
    if (group) group.pendingCount++
  }
  for (const position of state.positions) groups.get(position.setupId)?.positions.push(position)
  for (const position of state.closed) {
    const group = groups.get(position.setupId)
    group?.positions.push(position)
    group?.closed.push(position)
  }
  return [...groups.values()].map(({ setup, positions, closed, pendingCount }) => {
    positions.sort((a, b) => a.entryTime - b.entryTime || a.id.localeCompare(b.id))
    const openCount = positions.length - closed.length
    const status: SetupStatus = closed.length && (pendingCount || openCount) ? 'partially closed'
      : openCount ? 'open' : pendingCount ? 'pending' : closed.length ? 'completed' : 'rejected/cancelled'
    const initialRiskUsd = positions.reduce((sum, position) => sum + position.initialRiskUsd, 0)
    const grossPnlUsd = closed.reduce((sum, position) => sum + position.grossPnlUsd, 0)
    const totalCommissionUsd = closed.reduce((sum, position) => sum + position.totalCommissionUsd, 0)
    const netPnlUsd = closed.reduce((sum, position) => sum + position.netPnlUsd, 0)
    return { setup, positions, closed, status, initialRiskUsd, grossPnlUsd, totalCommissionUsd, netPnlUsd,
      entryTime: positions[0]?.entryTime ?? null,
      exitTime: status === 'completed' ? Math.max(...closed.map((position) => position.exitTime)) : null,
      netR: status === 'completed' ? netR(netPnlUsd, initialRiskUsd) : null,
      coverageUncertain: positions.some((position) => position.coverageWarnings.length > 0) }
  })
}
export type SetupJournalRow = ReturnType<typeof journalSetups>[number]

export function completedObservations(rows: readonly SetupJournalRow[]): Observation[] {
  return rows.filter((row) => row.status === 'completed').map((row) => ({
    id: row.setup.id, entryTime: row.entryTime!, exitTime: row.exitTime!,
    grossPnlUsd: row.grossPnlUsd, totalCommissionUsd: row.totalCommissionUsd,
    netPnlUsd: row.netPnlUsd, initialRiskUsd: row.initialRiskUsd,
  }))
}

export function performanceStats(observations: readonly Observation[], referenceBalance: number) {
  const count = observations.length
  const winners = observations.filter((item) => item.netPnlUsd > 0)
  const losers = observations.filter((item) => item.netPnlUsd < 0)
  const sum = (items: readonly Observation[], key: 'netPnlUsd' | 'grossPnlUsd' | 'totalCommissionUsd') => items.reduce((total, item) => total + item[key], 0)
  const profits = sum(winners, 'netPnlUsd')
  const losses = sum(losers, 'netPnlUsd')
  const netPnlUsd = sum(observations, 'netPnlUsd')
  const rs = observations.map((item) => netR(item.netPnlUsd, item.initialRiskUsd)).filter((r): r is number => r !== null)
  const totalNetR = rs.length ? rs.reduce((total, r) => total + r, 0) : null
  return { count, netPnlUsd, grossPnlUsd: sum(observations, 'grossPnlUsd'), totalCommissionUsd: sum(observations, 'totalCommissionUsd'),
    winningCount: winners.length, losingCount: losers.length, zeroCount: count - winners.length - losers.length,
    nonWinningCount: count - winners.length, winRatePercent: count ? winners.length / count * 100 : null,
    profitFactor: losses < 0 ? profits / -losses : profits > 0 ? Infinity : null,
    averageWinnerUsd: winners.length ? profits / winners.length : null,
    averageLoserUsd: losers.length ? losses / losers.length : null,
    largestWinnerUsd: winners.length ? Math.max(...winners.map((item) => item.netPnlUsd)) : null,
    largestLoserUsd: losers.length ? Math.min(...losers.map((item) => item.netPnlUsd)) : null,
    totalNetR, averageNetR: totalNetR === null ? null : totalNetR / rs.length, validRCount: rs.length,
    averageHoldingMs: count ? observations.reduce((total, item) => total + item.exitTime - item.entryTime, 0) / count : null,
    netReturnPercent: Number.isFinite(referenceBalance) && referenceBalance > 0 ? netPnlUsd / referenceBalance * 100 : null }
}

export interface RealizedPoint {
  positionId: string | null
  timestamp: number | null
  cumulativeNetPnlUsd: number
  balanceUsd: number
  highWaterMarkUsd: number
  drawdownUsd: number
  drawdownPercent: number | null
}

// Exit order in state is the deterministic engine event order. Preserve that
// order for simultaneous exits; never collapse them into one timestamp bucket.
export function realizedPerformance(closed: readonly ClosedTrade[], referenceBalance: number) {
  const ordered = closed.map((trade, index) => ({ trade, index }))
    .sort((a, b) => a.trade.exitTime - b.trade.exitTime || a.index - b.index)
  let cumulativeNetPnlUsd = 0
  let highWaterMarkUsd = referenceBalance
  let maxDrawdownUsd = 0
  let maxDrawdownPercent = 0
  let percentageAvailable = Number.isFinite(referenceBalance) && referenceBalance > 0
  let nonpositiveBalance = false
  const points: RealizedPoint[] = [{ positionId: null, timestamp: null, cumulativeNetPnlUsd: 0,
    balanceUsd: referenceBalance, highWaterMarkUsd, drawdownUsd: 0, drawdownPercent: percentageAvailable ? 0 : null }]
  for (const { trade } of ordered) {
    cumulativeNetPnlUsd += trade.netPnlUsd
    const balanceUsd = referenceBalance + cumulativeNetPnlUsd
    highWaterMarkUsd = Math.max(highWaterMarkUsd, balanceUsd)
    const drawdownUsd = highWaterMarkUsd - balanceUsd
    nonpositiveBalance ||= balanceUsd <= 0
    const drawdownPercent = balanceUsd > 0 && highWaterMarkUsd > 0 ? drawdownUsd / highWaterMarkUsd * 100 : null
    percentageAvailable &&= drawdownPercent !== null
    maxDrawdownUsd = Math.max(maxDrawdownUsd, drawdownUsd)
    if (drawdownPercent !== null) maxDrawdownPercent = Math.max(maxDrawdownPercent, drawdownPercent)
    points.push({ positionId: trade.id, timestamp: trade.exitTime, cumulativeNetPnlUsd, balanceUsd, highWaterMarkUsd, drawdownUsd, drawdownPercent })
  }
  return { points, maxDrawdownUsd, maxDrawdownPercent: percentageAvailable ? maxDrawdownPercent : null, nonpositiveBalance }
}

export function executedPositions(state: TradingState): (Position | ClosedTrade)[] {
  return [...state.positions, ...state.closed].sort((a, b) => a.entryTime - b.entryTime || a.id.localeCompare(b.id))
}

export function isClosed(position: Position): position is ClosedTrade { return 'exitTime' in position }
export function positionStatus(position: Position): string {
  return isClosed(position) ? 'closed' : position.closeRequestedAt !== null ? 'pending close' : 'open'
}

export function setupMetadataMap(setups: readonly TradingSetup[]) {
  return new Map(setups.map((setup) => [setup.id, setup]))
}
