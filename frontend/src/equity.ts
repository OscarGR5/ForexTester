import { grossPnl, quoteCandle, type TradingState } from './trading.js'

export interface EquityPoint {
  timestamp: number
  cashUsd: number
  unrealizedUsd: number | null
  equityUsd: number | null
  drawdownUsd: number | null
  drawdownPercent: number | null
  missingSides: ('bid' | 'ask' | 'trade')[]
  clockGap: boolean
}
export interface EquityLedger {
  // Persistent linked observations: O(1) append, safe under React StrictMode.
  tail: { point: EquityPoint; previous: EquityLedger['tail'] } | null
  count: number
  cashUsd: number
  highWaterMarkUsd: number
  maxDrawdownUsd: number
  maxDrawdownPercent: number | null
  nonpositiveEquity: boolean
  missingCount: number
}
export function createEquityLedger(referenceBalance: number): EquityLedger {
  return { tail: null, count: 0, cashUsd: referenceBalance, highWaterMarkUsd: referenceBalance,
    maxDrawdownUsd: 0, maxDrawdownPercent: 0, nonpositiveEquity: false, missingCount: 0 }
}

// Called exactly once after each engine observation, never from chart prices.
export function recordEquity(ledger: EquityLedger, previous: TradingState, state: TradingState): EquityLedger {
  if (state.observedTimestamp === null || state.observedTimestamp === ledger.tail?.point.timestamp) return ledger
  const newCloses = state.closed.slice(previous.closed.length)
  // Include new entries which also stopped out in this same M1 observation.
  const previousIds = new Set(previous.positions.map((position) => position.id))
  const entries = [...state.positions, ...newCloses].filter((position) => !previousIds.has(position.id))
  const cashUsd = ledger.cashUsd + newCloses.reduce((sum, position) => sum + position.grossPnlUsd - position.exitCommissionUsd, 0)
    - entries.reduce((sum, position) => sum + position.entryCommissionUsd, 0)
  const missingSides = new Set<'bid' | 'ask' | 'trade'>()
  let gross = 0
  for (const position of state.positions) {
    const side = state.quote && 'priceModel' in state.quote ? 'trade' : position.direction === 'buy' ? 'bid' : 'ask'
    const quote = quoteCandle(state.quote, side)
    if (!quote || quote.timestamp !== state.observedTimestamp) missingSides.add(side)
    else gross += grossPnl(position, quote.close).usd
  }
  const unrealizedUsd = missingSides.size ? null : gross
  const equityUsd = unrealizedUsd === null ? null : cashUsd + unrealizedUsd
  const highWaterMarkUsd = equityUsd === null ? ledger.highWaterMarkUsd : Math.max(ledger.highWaterMarkUsd, equityUsd)
  const drawdownUsd = equityUsd === null ? null : highWaterMarkUsd - equityUsd
  const drawdownPercent = equityUsd !== null && equityUsd > 0 && highWaterMarkUsd > 0
    ? drawdownUsd! / highWaterMarkUsd * 100 : null
  const nonpositiveEquity = ledger.nonpositiveEquity || (equityUsd !== null && equityUsd <= 0)
  const point: EquityPoint = { timestamp: state.observedTimestamp, cashUsd, unrealizedUsd, equityUsd, drawdownUsd,
    drawdownPercent, missingSides: [...missingSides],
    clockGap: ledger.tail !== null && state.observedTimestamp > ledger.tail.point.timestamp + 60_000 }
  return { tail: { point, previous: ledger.tail }, count: ledger.count + 1, cashUsd, highWaterMarkUsd,
    maxDrawdownUsd: Math.max(ledger.maxDrawdownUsd, drawdownUsd ?? 0),
    maxDrawdownPercent: nonpositiveEquity ? null : Math.max(ledger.maxDrawdownPercent ?? 0, drawdownPercent ?? 0),
    nonpositiveEquity, missingCount: ledger.missingCount + (missingSides.size ? 1 : 0) }
}
