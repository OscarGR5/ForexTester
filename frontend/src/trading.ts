import type { Candle } from './history'
import { accountRiskError, DEFAULT_ACCOUNT_RISK, exceedsRisk, plannedRisk, riskBudget, sizeFromRisk, validRiskPercent, type AccountRisk, type EntrySizing } from './risk'

export type Direction = 'buy' | 'sell'
export interface PendingEntry {
  id: string
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
export interface CoverageWarning { from: number; to: number; side: 'bid' | 'ask'; reason: 'missing_quote' | 'clock_gap' }
export interface Position extends PendingEntry {
  lots: number
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
  exitTime: number
  exitPrice: number
  exitReason: 'manual' | 'stop_loss'
  stopFillType: 'level' | 'gap_open' | null
}
export interface RejectedEntry extends PendingEntry { rejectedAt: number; reason: string }
export interface Quote { bid: Candle | null; ask: Candle | null }
export interface TradingState {
  account: AccountRisk
  session: number
  nextId: number
  observedTimestamp: number | null
  quote: Quote | null
  pending: PendingEntry[]
  positions: Position[]
  closed: ClosedTrade[]
  rejected: RejectedEntry[]
}
export interface TradingPermission { active: boolean; playing: boolean; hasFuture: boolean }

export function createTradingState(session = 0, account: AccountRisk = DEFAULT_ACCOUNT_RISK): TradingState {
  return { account: { ...account }, session, nextId: 1, observedTimestamp: null, quote: null, pending: [], positions: [], closed: [], rejected: [] }
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

export function entryRequestError(state: TradingState, sizing: EntrySizing, stopPrice: number): string | null {
  const configurationError = accountRiskError(state.account)
  if (configurationError) return configurationError
  if (!validStopPrice(stopPrice)) return 'Enter a required positive, finite SL price.'
  if (typeof sizing === 'number') return validLots(sizing) ? null : 'Enter a positive, finite volume in lots.'
  if (!validRiskPercent(sizing.riskPercent)) return 'Risk per entry must be greater than 0 and at most 100%.'
  const budget = riskBudget(state.account.referenceBalance, sizing.riskPercent)
  if (exceedsRisk(budget, combinedRisk(state).remainingUsd)) return 'Requested allocation exceeds the remaining combined risk budget.'
  return null
}

export function requestEntry(state: TradingState, direction: Direction, sizing: EntrySizing, stopPrice: number, permission: TradingPermission): TradingState {
  if (!canRequestOrder(permission) || state.observedTimestamp === null || entryRequestError(state, sizing, stopPrice) ||
    state.pending.length + state.positions.length >= 2) return state
  const riskPercent = typeof sizing === 'number' ? null : sizing.riskPercent
  const order: PendingEntry = { id: `${state.session}-${state.nextId}`, direction,
    mode: typeof sizing === 'number' ? 'manual' : 'risk', lots: typeof sizing === 'number' ? sizing : null,
    requestedRiskPercent: riskPercent, requestedRiskUsd: riskPercent === null ? null : riskBudget(state.account.referenceBalance, riskPercent),
    stopPrice, requestedAt: state.observedTimestamp }
  return { ...state, nextId: state.nextId + 1, pending: [...state.pending, order] }
}

export function cancelEntry(state: TradingState, id: string): TradingState {
  if (!state.pending.some((order) => order.id === id)) return state
  return { ...state, pending: state.pending.filter((order) => order.id !== id) }
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
  const side = position.direction === 'buy' ? 'bid' : 'ask'
  const candle = state.quote?.[side]
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
export function observeCandle(state: TradingState, bid: Candle, ask?: Candle): TradingState {
  const timestamp = bid.timestamp
  if (state.observedTimestamp !== null && timestamp <= state.observedTimestamp) return state
  const quote: Quote = { bid: validCandle(bid, timestamp) ? bid : null, ask: validCandle(ask, timestamp) ? ask : null }
  const synchronized = quote.bid !== null && quote.ask !== null
  const positions: Position[] = []
  const closed = [...state.closed]
  const rejected = [...state.rejected]
  for (let position of state.positions) {
    if (state.observedTimestamp !== null && timestamp > state.observedTimestamp + 60_000) {
      position = warn(position, { from: state.observedTimestamp + 60_000, to: timestamp - 60_000,
        side: position.direction === 'buy' ? 'bid' : 'ask', reason: 'clock_gap' })
    }
    // A synchronized manual exit at the opening precedes intrabar stops.
    if (synchronized && position.closeRequestedAt !== null && timestamp > position.closeRequestedAt) {
      closed.push({ ...position, exitTime: timestamp, exitPrice: position.direction === 'buy' ? quote.bid!.open : quote.ask!.open,
        exitReason: 'manual', stopFillType: null })
    } else positions.push(position)
  }
  const pending: PendingEntry[] = []
  let reservedUsd = state.pending.reduce((sum, order) => sum + (order.requestedRiskUsd ?? 0), 0)
  for (const order of state.pending) {
    if (synchronized && timestamp > order.requestedAt) {
      reservedUsd -= order.requestedRiskUsd ?? 0
      const entryPrice = order.direction === 'buy' ? quote.ask!.open : quote.bid!.open
      if (order.direction === 'buy' ? order.stopPrice >= entryPrice : order.stopPrice <= entryPrice) {
        rejected.push({ ...order, rejectedAt: timestamp,
          reason: `SL ${formatTradingNumber(order.stopPrice, 5)} must be ${order.direction === 'buy' ? 'below' : 'above'} actual entry ${formatTradingNumber(entryPrice, 5)}.` })
      } else {
        const lots = order.mode === 'risk' ? sizeFromRisk(order.requestedRiskUsd!, entryPrice, order.stopPrice) : order.lots
        const initialRiskUsd = lots === null ? Infinity : plannedRisk({ ...order, entryPrice, lots })
        const usedUsd = positions.reduce((sum, position) => sum + plannedRisk(position), 0) + reservedUsd
        const maximumUsd = riskBudget(state.account.referenceBalance, state.account.maxRiskPercent)
        const reason = lots === null || !validLots(lots)
          ? 'Calculated volume is below 0.01 lots or cannot be represented safely. Entry rejected.'
          : !Number.isFinite(initialRiskUsd) ? 'Actual planned risk cannot be represented safely. Entry rejected.'
          : exceedsRisk(usedUsd + initialRiskUsd, maximumUsd) ? 'Actual entry risk exceeds the combined risk cap, including pending allocations.' : null
        if (reason) rejected.push({ ...order, rejectedAt: timestamp, reason })
        else positions.push({ ...order, lots: lots!, initialRiskUsd,
          initialRiskPercent: initialRiskUsd / state.account.referenceBalance * 100, referenceBalance: state.account.referenceBalance,
          entryTime: timestamp, entryPrice, closeRequestedAt: null,
          stopEffectiveAfter: order.requestedAt, stopModifications: [], coverageWarnings: [] })
      }
    } else pending.push(order)
  }
  const surviving: Position[] = []
  for (let position of positions) {
    const side = position.direction === 'buy' ? 'bid' : 'ask'
    const candle = quote[side]
    if (!candle) {
      position = warn(position, { from: timestamp, to: timestamp, side, reason: 'missing_quote' })
    } else if (timestamp > position.stopEffectiveAfter) {
      const gap = position.direction === 'buy' ? candle.open < position.stopPrice : candle.open > position.stopPrice
      const touched = position.direction === 'buy' ? candle.low <= position.stopPrice : candle.high >= position.stopPrice
      if (gap || touched) {
        closed.push({ ...position, exitTime: timestamp, exitPrice: gap ? candle.open : position.stopPrice,
          exitReason: 'stop_loss', stopFillType: gap ? 'gap_open' : 'level' })
        continue
      }
    }
    surviving.push(position)
  }
  return { ...state, observedTimestamp: timestamp, quote, pending, positions: surviving, closed, rejected }
}

// Keep full precision in state; round only when formatting for display.
export function grossPnl(position: Pick<Position, 'direction' | 'entryPrice' | 'lots'>, exitPrice: number) {
  const difference = (exitPrice - position.entryPrice) * (position.direction === 'buy' ? 1 : -1)
  return { pips: difference / 0.0001, usd: difference * 100_000 * position.lots }
}

export function markPosition(position: Position, quote: Quote | null) {
  if (!quote?.bid || !quote.ask) return null
  const price = position.direction === 'buy' ? quote.bid.close : quote.ask.close
  return { price, ...grossPnl(position, price) }
}

export function formatTradingNumber(value: number, digits: number): string {
  const rounded = value.toFixed(digits)
  return Number(rounded) === 0 ? (0).toFixed(digits) : rounded
}

export function tradingTime(timestamp: number): string {
  return `${new Date(timestamp).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}
