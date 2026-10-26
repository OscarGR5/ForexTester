import type { Candle } from './history.js'
import { commissionConfigError, DEFAULT_COMMISSION, perSideCommissionUsd, type CommissionConfig } from './commissions.js'
import { accountRiskError, DEFAULT_ACCOUNT_RISK, exceedsRisk, plannedRisk, riskBudget, sizeFromRisk, validRiskPercent, type AccountRisk, type EntrySizing } from './risk.js'

export type Direction = 'buy' | 'sell'
export interface SetupMetadata { title: string; tag: string; notes: string }
export interface TradingSetup extends SetupMetadata { id: string; symbol: 'EURUSD' | '6E'; direction: Direction }
export type SetupStatus = 'pending' | 'open' | 'partially closed' | 'completed' | 'rejected/cancelled'
export interface PendingEntry {
  id: string
  setupId: string
  direction: Direction
  lots: number | null
  mode: 'risk' | 'manual'
  requestedRiskPercent: number | null
  requestedRiskUsd: number | null
  stopPrice: number
  requestedAt: number
}
export interface StopModification { oldPrice: number; newPrice: number; timestamp: number }
// Inclusive M1 timestamps without usable stop-side observations. Gaps include
// market closures because candle history cannot establish what happened there.
export interface CoverageWarning { from: number; to: number; side: 'bid' | 'ask' | 'trade'; reason: 'missing_quote' | 'clock_gap' }
export interface Position extends PendingEntry {
  lots: number
  initialStopPrice: number
  commission: CommissionConfig
  entryCommissionUsd: number
  initialRiskUsd: number
  initialRiskPercent: number
  referenceBalance: number
  entryTime: number
  entryPrice: number
  closeRequestedAt: number | null
  stopEffectiveAfter: number
  stopModifications: StopModification[]
  coverageWarnings: CoverageWarning[]
}
export interface ClosedTrade extends Position {
  grossPnlUsd: number
  exitCommissionUsd: number
  totalCommissionUsd: number
  netPnlUsd: number
  exitTime: number
  exitPrice: number
  exitReason: 'manual' | 'stop_loss'
  stopFillType: 'level' | 'gap_open' | null
}
export interface RejectedEntry extends PendingEntry { rejectedAt: number; reason: string }
export interface CancelledEntry extends PendingEntry { cancelledAt: number }
export type Quote = { bid: Candle | null; ask: Candle | null } | { priceModel: 'single'; trade: Candle | null; bid?: never; ask?: never }
export function quoteCandle(quote: Quote | null, side: 'bid' | 'ask' | 'trade'): Candle | null {
  return quote && 'priceModel' in quote ? quote.trade : quote && side !== 'trade' ? quote[side] : null
}
export function observedPrice(quote: Quote | null, direction: Direction): number | null {
  if (!quote) return null
  if ('priceModel' in quote) return quote.trade?.close ?? null
  return quote.bid && quote.ask ? quote[direction === 'buy' ? 'ask' : 'bid']!.close : null
}
export interface TradingState {
  symbol?: 'EURUSD' | '6E'
  executionModel?: 'single-price-m1-v1'
  account: AccountRisk
  commission: CommissionConfig
  session: number
  nextId: number
  nextSetupId: number
  setups: TradingSetup[]
  observedTimestamp: number | null
  quote: Quote | null
  pending: PendingEntry[]
  positions: Position[]
  closed: ClosedTrade[]
  rejected: RejectedEntry[]
  cancelled: CancelledEntry[]
}
export interface TradingPermission { active: boolean; playing: boolean; hasFuture: boolean }

export function createTradingState(session = 0, account: AccountRisk = DEFAULT_ACCOUNT_RISK, commission: CommissionConfig = DEFAULT_COMMISSION): TradingState {
  const error = commissionConfigError(commission)
  if (error) throw new Error(error)
  return { account: { ...account }, commission: { ...commission }, session, nextId: 1, nextSetupId: 1, setups: [], observedTimestamp: null, quote: null, pending: [], positions: [], closed: [], rejected: [], cancelled: [] }
}

export function setupEntries(state: TradingState, setupId: string) {
  return { pending: state.pending.filter((entry) => entry.setupId === setupId),
    open: state.positions.filter((entry) => entry.setupId === setupId),
    closed: state.closed.filter((entry) => entry.setupId === setupId) }
}

export function setupStatus(state: TradingState, setupId: string): SetupStatus {
  const { pending, open, closed } = setupEntries(state, setupId)
  if (closed.length && (pending.length || open.length)) return 'partially closed'
  if (open.length) return 'open'
  if (pending.length) return 'pending'
  return closed.length ? 'completed' : 'rejected/cancelled'
}

export function setupAssignmentError(state: TradingState, direction: Direction, setupId: string | null): string | null {
  if (setupId === null) return null
  const setup = state.setups.find((item) => item.id === setupId)
  if (!setup) return 'Selected setup does not exist in this session.'
  if (setup.direction !== direction) return 'The entry direction must match the selected setup.'
  const { pending, open, closed } = setupEntries(state, setupId)
  if (!pending.length && !open.length) return 'Only setups with a pending or open entry can accept another entry.'
  if (pending.length + open.length + closed.length >= 2) return 'A setup can contain at most two submitted entry slots.'
  return null
}

export function updateSetupMetadata(state: TradingState, id: string, metadata: SetupMetadata): TradingState {
  if (!state.setups.some((setup) => setup.id === id)) return state
  return { ...state, setups: state.setups.map((setup) => setup.id === id
    ? { ...setup, title: metadata.title, tag: metadata.tag, notes: metadata.notes } : setup) }
}

export function validLots(lots: number): boolean {
  return Number.isFinite(lots) && lots > 0
}
export const validStopPrice = validLots

export function canRequestOrder(permission: TradingPermission): boolean {
  return permission.active && !permission.playing && permission.hasFuture
}

export function combinedRisk(state: TradingState) {
  const openUsd = state.positions.reduce((sum, position) => sum + plannedRisk(position), 0)
  const reservedUsd = state.pending.reduce((sum, order) => sum + (order.requestedRiskUsd ?? 0), 0)
  const maximumUsd = riskBudget(state.account.referenceBalance, state.account.maxRiskPercent)
  return { openUsd, reservedUsd, maximumUsd, usedUsd: openUsd + reservedUsd,
    remainingUsd: Math.max(0, maximumUsd - openUsd - reservedUsd) }
}

export function configureAccount(state: TradingState, account: AccountRisk, permission: TradingPermission): TradingState {
  if (permission.active || state.positions.length || state.pending.length) return state
  return { ...state, account: { ...account } }
}

export function configureCommission(state: TradingState, commission: CommissionConfig, permission: TradingPermission): TradingState {
  if (permission.active || state.positions.length || state.pending.length || commissionConfigError(commission)) return state
  return { ...state, commission: { ...commission } }
}

export function entryRequestError(state: TradingState, sizing: EntrySizing, stopPrice: number): string | null {
  const configurationError = accountRiskError(state.account) ?? commissionConfigError(state.commission)
  if (configurationError) return configurationError
  if (!validStopPrice(stopPrice)) return 'Enter a required positive, finite SL price.'
  if (typeof sizing === 'number') return validLots(sizing) ? null : 'Enter a positive, finite volume in lots.'
  if (!validRiskPercent(sizing.riskPercent)) return 'Risk per entry must be greater than 0 and at most 100%.'
  const budget = riskBudget(state.account.referenceBalance, sizing.riskPercent)
  if (exceedsRisk(budget, combinedRisk(state).remainingUsd)) return 'Requested allocation exceeds the remaining combined risk budget.'
  return null
}

export function requestEntry(state: TradingState, direction: Direction, sizing: EntrySizing, stopPrice: number, permission: TradingPermission, selectedSetupId: string | null = null): TradingState {
  if (!canRequestOrder(permission) || state.observedTimestamp === null || entryRequestError(state, sizing, stopPrice) ||
    setupAssignmentError(state, direction, selectedSetupId) ||
    state.pending.length + state.positions.length >= 2) return state
  const setupId = selectedSetupId ?? `${state.session}-S${state.nextSetupId}`
  const riskPercent = typeof sizing === 'number' ? null : sizing.riskPercent
  const order: PendingEntry = { id: `${state.session}-${state.nextId}`, setupId, direction,
    mode: typeof sizing === 'number' ? 'manual' : 'risk', lots: typeof sizing === 'number' ? sizing : null,
    requestedRiskPercent: riskPercent, requestedRiskUsd: riskPercent === null ? null : riskBudget(state.account.referenceBalance, riskPercent),
    stopPrice, requestedAt: state.observedTimestamp }
  return { ...state, nextId: state.nextId + 1, pending: [...state.pending, order],
    nextSetupId: state.nextSetupId + (selectedSetupId === null ? 1 : 0),
    setups: selectedSetupId === null ? [...state.setups, { id: setupId, symbol: state.symbol ?? 'EURUSD', direction, title: '', tag: '', notes: '' }] : state.setups }
}

export function cancelEntry(state: TradingState, id: string): TradingState {
  const order = state.pending.find((item) => item.id === id)
  if (!order || state.observedTimestamp === null) return state
  return { ...state, pending: state.pending.filter((order) => order.id !== id),
    cancelled: [...state.cancelled, { ...order, cancelledAt: state.observedTimestamp }] }
}

export function requestClose(state: TradingState, id: string, permission: TradingPermission): TradingState {
  if (!canRequestOrder(permission) || state.observedTimestamp === null) return state
  const position = state.positions.find((item) => item.id === id)
  if (!position || position.closeRequestedAt !== null) return state
  return { ...state, positions: state.positions.map((item) => item.id === id
    ? { ...item, closeRequestedAt: state.observedTimestamp } : item) }
}

export function stopModificationError(state: TradingState, position: Position, price: number, permission: TradingPermission): string | null {
  if (!canRequestOrder(permission)) return 'SL changes require paused replay with another candle available.'
  if (!validStopPrice(price)) return 'Enter a positive, finite SL price.'
  const side = state.quote && 'priceModel' in state.quote ? 'trade' : position.direction === 'buy' ? 'bid' : 'ask'
  const candle = quoteCandle(state.quote, side)
  if (!candle) return `Cannot change SL: current ${side} closing quote is unavailable.`
  if (position.direction === 'buy' ? price >= candle.close : price <= candle.close) {
    return `SL must be ${position.direction === 'buy' ? 'below' : 'above'} current ${side} close ${formatTradingNumber(candle.close, 5)}.`
  }
  const exposure = combinedRisk(state)
  const updated = exposure.usedUsd - plannedRisk(position) + plannedRisk({ ...position, stopPrice: price })
  if (exceedsRisk(updated, exposure.maximumUsd)) return 'SL change exceeds the combined risk cap, including pending allocations.'
  return null
}

export function modifyStop(state: TradingState, id: string, price: number, permission: TradingPermission): TradingState {
  const position = state.positions.find((item) => item.id === id)
  if (!position || state.observedTimestamp === null || position.stopPrice === price || stopModificationError(state, position, price, permission)) return state
  const timestamp = state.observedTimestamp
  return { ...state, positions: state.positions.map((item) => item.id !== id ? item : {
    ...item, stopPrice: price, stopEffectiveAfter: timestamp,
    stopModifications: [...item.stopModifications, { oldPrice: item.stopPrice, newPrice: price, timestamp }],
  }) }
}

function validCandle(candle: Candle | undefined, timestamp: number): candle is Candle {
  return !!candle && candle.timestamp === timestamp && [candle.open, candle.high, candle.low, candle.close].every(validStopPrice) &&
    candle.low <= Math.min(candle.open, candle.close) && candle.high >= Math.max(candle.open, candle.close)
}

function warn(position: Position, warning: CoverageWarning): Position {
  const warnings = [...position.coverageWarnings]
  const last = warnings.at(-1)
  if (last && last.reason === warning.reason && last.side === warning.side && last.to + 60_000 === warning.from) {
    warnings[warnings.length - 1] = { ...last, to: warning.to }
  } else warnings.push(warning)
  return { ...position, coverageWarnings: warnings }
}

// Only newly revealed candles reach this pure transition. Never inspect future
// history. Entries use opens; stop exits use the triggering side's open and range.
export function observeCandle(state: TradingState, bid: Candle, ask?: Candle, priceModel: 'bid-ask' | 'single' = 'bid-ask'): TradingState {
  if (priceModel === 'single' && state.quote && 'priceModel' in state.quote && state.quote.trade) {
    const previousId = (state.quote.trade as Candle & { instrumentId?: number }).instrumentId
    const nextId = (bid as Candle & { instrumentId?: number }).instrumentId
    if (previousId !== undefined && nextId !== previousId) throw new Error('Replay blocked at contract rollover; no execution was applied.')
  }
  const timestamp = bid.timestamp
  if (state.observedTimestamp !== null && timestamp <= state.observedTimestamp) return state
  const quote: Quote = priceModel === 'single' ? { priceModel: 'single', trade: validCandle(bid, timestamp) ? bid : null }
    : { bid: validCandle(bid, timestamp) ? bid : null, ask: validCandle(ask, timestamp) ? ask : null }
  const synchronized = priceModel === 'single' ? quoteCandle(quote, 'trade') !== null : quoteCandle(quote, 'bid') !== null && quoteCandle(quote, 'ask') !== null
  const positions: Position[] = []
  const closed: ClosedTrade[] = []
  const rejected: RejectedEntry[] = []
  for (let position of state.positions) {
    if (state.observedTimestamp !== null && timestamp > state.observedTimestamp + 60_000) {
      position = warn(position, { from: state.observedTimestamp + 60_000, to: timestamp - 60_000,
        side: priceModel === 'single' ? 'trade' : position.direction === 'buy' ? 'bid' : 'ask', reason: 'clock_gap' })
    }
    // A synchronized manual exit at the opening precedes intrabar stops.
    if (synchronized && position.closeRequestedAt !== null && timestamp > position.closeRequestedAt) {
      closed.push(closePosition(position, timestamp, quoteCandle(quote, position.direction === 'buy' ? 'bid' : 'ask')!.open, 'manual', null))
    } else positions.push(position)
  }
  const pending: PendingEntry[] = []
  let reservedUsd = state.pending.reduce((sum, order) => sum + (order.requestedRiskUsd ?? 0), 0)
  for (const order of state.pending) {
    if (synchronized && timestamp > order.requestedAt) {
      reservedUsd -= order.requestedRiskUsd ?? 0
      const entryPrice = quoteCandle(quote, order.direction === 'buy' ? 'ask' : 'bid')!.open
      if (order.direction === 'buy' ? order.stopPrice >= entryPrice : order.stopPrice <= entryPrice) {
        rejected.push({ ...order, rejectedAt: timestamp,
          reason: `SL ${formatTradingNumber(order.stopPrice, 5)} must be ${order.direction === 'buy' ? 'below' : 'above'} actual entry ${formatTradingNumber(entryPrice, 5)}.` })
      } else {
        const lots = order.mode === 'risk' ? sizeFromRisk(order.requestedRiskUsd!, entryPrice, order.stopPrice) : order.lots
        const initialRiskUsd = lots === null ? Infinity : plannedRisk({ ...order, entryPrice, lots })
        const usedUsd = positions.reduce((sum, position) => sum + plannedRisk(position), 0) + reservedUsd
        const maximumUsd = riskBudget(state.account.referenceBalance, state.account.maxRiskPercent)
        const entryCommissionUsd = lots === null ? 0 : perSideCommissionUsd(lots, state.commission)
        const reason = lots === null || !validLots(lots)
          ? 'Calculated volume is below 0.01 lots or cannot be represented safely. Entry rejected.'
          : !Number.isFinite(entryCommissionUsd * 2) ? 'Commission cannot be represented safely. Entry rejected.'
          : !Number.isFinite(initialRiskUsd) ? 'Actual planned risk cannot be represented safely. Entry rejected.'
          : exceedsRisk(usedUsd + initialRiskUsd, maximumUsd) ? 'Actual entry risk exceeds the combined risk cap, including pending allocations.' : null
        if (reason) rejected.push({ ...order, rejectedAt: timestamp, reason })
        else positions.push({ ...order, lots: lots!, initialStopPrice: order.stopPrice, commission: { ...state.commission }, entryCommissionUsd, initialRiskUsd,
          initialRiskPercent: initialRiskUsd / state.account.referenceBalance * 100, referenceBalance: state.account.referenceBalance,
          entryTime: timestamp, entryPrice, closeRequestedAt: null,
          stopEffectiveAfter: order.requestedAt, stopModifications: [], coverageWarnings: [] })
      }
    } else pending.push(order)
  }
  const surviving: Position[] = []
  for (let position of positions) {
    const side = position.direction === 'buy' ? 'bid' : 'ask'
    const candle = quoteCandle(quote, side)
    if (!candle) {
      position = warn(position, { from: timestamp, to: timestamp, side: priceModel === 'single' ? 'trade' : side, reason: 'missing_quote' })
    } else if (timestamp > position.stopEffectiveAfter) {
      const gap = position.direction === 'buy' ? candle.open < position.stopPrice : candle.open > position.stopPrice
      const touched = position.direction === 'buy' ? candle.low <= position.stopPrice : candle.high >= position.stopPrice
      if (gap || touched) {
        closed.push(closePosition(position, timestamp, gap ? candle.open : position.stopPrice, 'stop_loss', gap ? 'gap_open' : 'level'))
        continue
      }
    }
    surviving.push(position)
  }
  // Quote-only observations preserve record identities for journal/curve memoization.
  return { ...state, ...(priceModel === 'single' ? { symbol: state.symbol ?? '6E' as const } : {}), observedTimestamp: timestamp, quote,
    pending: pending.length === state.pending.length ? state.pending : pending,
    positions: surviving.length === state.positions.length && surviving.every((position, index) => position === state.positions[index]) ? state.positions : surviving,
    closed: closed.length ? [...state.closed, ...closed] : state.closed,
    rejected: rejected.length ? [...state.rejected, ...rejected] : state.rejected }
}

// Keep full precision in state; round only when formatting for display.
export function grossPnl(position: Pick<Position, 'direction' | 'entryPrice' | 'lots'>, exitPrice: number) {
  const difference = (exitPrice - position.entryPrice) * (position.direction === 'buy' ? 1 : -1)
  return { pips: difference / 0.0001, usd: difference * 100_000 * position.lots }
}

function closePosition(position: Position, exitTime: number, exitPrice: number, exitReason: ClosedTrade['exitReason'], stopFillType: ClosedTrade['stopFillType']): ClosedTrade {
  const grossPnlUsd = grossPnl(position, exitPrice).usd
  const exitCommissionUsd = perSideCommissionUsd(position.lots, position.commission)
  const totalCommissionUsd = position.entryCommissionUsd + exitCommissionUsd
  return { ...position, exitTime, exitPrice, exitReason, stopFillType,
    grossPnlUsd, exitCommissionUsd, totalCommissionUsd, netPnlUsd: grossPnlUsd - totalCommissionUsd }
}

export function realizedSummary(trades: readonly ClosedTrade[]) {
  return trades.reduce((summary, trade) => ({ count: summary.count + 1,
    grossPnlUsd: summary.grossPnlUsd + trade.grossPnlUsd,
    totalCommissionUsd: summary.totalCommissionUsd + trade.totalCommissionUsd,
    netPnlUsd: summary.netPnlUsd + trade.netPnlUsd,
  }), { count: 0, grossPnlUsd: 0, totalCommissionUsd: 0, netPnlUsd: 0 })
}

export function stopLossEstimates(position: Position) {
  const expectedCommissionUsd = position.entryCommissionUsd + perSideCommissionUsd(position.lots, position.commission)
  return { initialLossUsd: position.initialRiskUsd + expectedCommissionUsd,
    currentLossUsd: Math.max(0, -grossPnl(position, position.stopPrice).usd + expectedCommissionUsd) }
}

export function markPosition(position: Position, quote: Quote | null) {
  if (!quote || !('priceModel' in quote) && (!quote.bid || !quote.ask)) return null
  const bar = quoteCandle(quote, position.direction === 'buy' ? 'bid' : 'ask')
  if (!bar) return null
  const price = bar.close
  const gross = grossPnl(position, price)
  const estimatedExitCommissionUsd = perSideCommissionUsd(position.lots, position.commission)
  return { price, ...gross, estimatedExitCommissionUsd,
    estimatedNetPnlUsd: gross.usd - position.entryCommissionUsd - estimatedExitCommissionUsd }
}

export function combinedOpenPnl(state: Pick<TradingState, 'positions' | 'quote' | 'account'>) {
  if (!state.positions.length || !Number.isFinite(state.account.referenceBalance) || state.account.referenceBalance <= 0) return null
  let estimatedNetPnlUsd = 0
  for (const position of state.positions) {
    const mark = markPosition(position, state.quote)
    if (!mark || !Number.isFinite(mark.estimatedNetPnlUsd)) return null
    estimatedNetPnlUsd += mark.estimatedNetPnlUsd
  }
  return { estimatedNetPnlUsd, percent: estimatedNetPnlUsd / state.account.referenceBalance * 100 }
}

export function formatTradingNumber(value: number, digits: number): string {
  const rounded = value.toFixed(digits)
  return Number(rounded) === 0 ? (0).toFixed(digits) : rounded
}

export function tradingTime(timestamp: number): string {
  return `${new Date(timestamp).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

// Historical setup records are never regrouped. Only new submissions use this policy.
export function activeSetupId(state: TradingState): string | null {
  return [...state.pending, ...state.positions][0]?.setupId ?? null
}
export function automaticSetupError(state: TradingState, direction: Direction, setupId: string | null): string | null {
  const active = [...new Set([...state.pending, ...state.positions].map(p => p.setupId))]
  if (active.length > 1) return 'Resolve the existing concurrent setups before submitting another entry.'
  const current = active[0] ?? null
  if (setupId !== null && setupId !== current) return 'Only the active setup can accept an entry.'
  if (!current) return null
  const setup = state.setups.find(item => item.id === current)
  if (!setup) return 'Active setup does not exist in this session.'
  if (setup.direction !== direction) return 'The entry direction must match the active setup.'
  const submitted = [...state.pending, ...state.positions, ...state.closed, ...state.cancelled, ...state.rejected]
    .filter(entry => entry.setupId === current).length
  if (submitted >= 2) return 'The active setup has used both submitted entry slots. Resolve it before starting another setup.'
  return null
}

export function requestAutomaticEntry(state: TradingState, direction: Direction, sizing: EntrySizing, stopPrice: number, permission: TradingPermission): TradingState {
  if (automaticSetupError(state, direction, activeSetupId(state))) return state
  return requestEntry(state, direction, sizing, stopPrice, permission, activeSetupId(state))
}
