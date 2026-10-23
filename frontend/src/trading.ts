import type { Candle } from './history'

export type Direction = 'buy' | 'sell'
export interface PendingEntry {
  id: string
  direction: Direction
  lots: number
  stopPrice: number
  requestedAt: number
}
export interface StopModification { oldPrice: number; newPrice: number; timestamp: number }
// Inclusive M1 timestamps without usable stop-side observations. Gaps include
// market closures because candle history cannot establish what happened there.
export interface CoverageWarning { from: number; to: number; side: 'bid' | 'ask'; reason: 'missing_quote' | 'clock_gap' }
export interface Position extends PendingEntry {
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

export function createTradingState(session = 0): TradingState {
  return { session, nextId: 1, observedTimestamp: null, quote: null, pending: [], positions: [], closed: [], rejected: [] }
}

export function validLots(lots: number): boolean {
  return Number.isFinite(lots) && lots > 0
}
export const validStopPrice = validLots

export function canRequestOrder(permission: TradingPermission): boolean {
  return permission.active && !permission.playing && permission.hasFuture
}

export function requestEntry(state: TradingState, direction: Direction, lots: number, stopPrice: number, permission: TradingPermission): TradingState {
  if (!canRequestOrder(permission) || state.observedTimestamp === null || !validLots(lots) || !validStopPrice(stopPrice) ||
    state.pending.length + state.positions.length >= 2) return state
  const order: PendingEntry = { id: `${state.session}-${state.nextId}`, direction, lots, stopPrice, requestedAt: state.observedTimestamp }
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
  for (const order of state.pending) {
    if (synchronized && timestamp > order.requestedAt) {
      const entryPrice = order.direction === 'buy' ? quote.ask!.open : quote.bid!.open
      if (order.direction === 'buy' ? order.stopPrice >= entryPrice : order.stopPrice <= entryPrice) {
        rejected.push({ ...order, rejectedAt: timestamp,
          reason: `SL ${formatTradingNumber(order.stopPrice, 5)} must be ${order.direction === 'buy' ? 'below' : 'above'} actual entry ${formatTradingNumber(entryPrice, 5)}.` })
      } else positions.push({ ...order, entryTime: timestamp, entryPrice, closeRequestedAt: null,
        stopEffectiveAfter: order.requestedAt, stopModifications: [], coverageWarnings: [] })
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
