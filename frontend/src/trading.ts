import type { Candle } from './history'

export type Direction = 'buy' | 'sell'
export interface PendingEntry {
  id: string
  direction: Direction
  lots: number
  requestedAt: number
}
export interface Position extends PendingEntry {
  entryTime: number
  entryPrice: number
  closeRequestedAt: number | null
}
export interface ClosedTrade extends Position {
  exitTime: number
  exitPrice: number
}
export interface Quote { bid: Candle; ask: Candle }
export interface TradingState {
  session: number
  nextId: number
  observedTimestamp: number | null
  quote: Quote | null
  pending: PendingEntry[]
  positions: Position[]
  closed: ClosedTrade[]
}
export interface TradingPermission { active: boolean; playing: boolean; hasFuture: boolean }

export function createTradingState(session = 0): TradingState {
  return { session, nextId: 1, observedTimestamp: null, quote: null, pending: [], positions: [], closed: [] }
}

export function validLots(lots: number): boolean {
  return Number.isFinite(lots) && lots > 0
}

export function canRequestOrder(permission: TradingPermission): boolean {
  return permission.active && !permission.playing && permission.hasFuture
}

export function requestEntry(state: TradingState, direction: Direction, lots: number, permission: TradingPermission): TradingState {
  if (!canRequestOrder(permission) || state.observedTimestamp === null || !validLots(lots) ||
    state.pending.length + state.positions.length >= 2) return state
  const order: PendingEntry = { id: `${state.session}-${state.nextId}`, direction, lots, requestedAt: state.observedTimestamp }
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

// The caller supplies only newly revealed bars, in clock order. No history access,
// timers, chart state, or side effects. Repeated/older observations are idempotent.
export function observeCandle(state: TradingState, bid: Candle, ask?: Candle): TradingState {
  if (state.observedTimestamp !== null && bid.timestamp <= state.observedTimestamp) return state
  const quote = ask?.timestamp === bid.timestamp ? { bid, ask } : null
  const next = { ...state, observedTimestamp: bid.timestamp, quote }
  if (!quote) return next

  const positions: Position[] = []
  const closed = [...state.closed]
  for (const position of state.positions) {
    if (position.closeRequestedAt !== null && bid.timestamp > position.closeRequestedAt) {
      closed.push({ ...position, exitTime: bid.timestamp,
        exitPrice: position.direction === 'buy' ? bid.open : quote.ask.open })
    } else positions.push(position)
  }
  const pending: PendingEntry[] = []
  for (const order of state.pending) {
    if (bid.timestamp > order.requestedAt) {
      positions.push({ ...order, entryTime: bid.timestamp,
        entryPrice: order.direction === 'buy' ? quote.ask.open : bid.open, closeRequestedAt: null })
    } else pending.push(order)
  }
  return { ...next, pending, positions, closed }
}

// Keep full precision in state; round only when formatting for display.
export function grossPnl(position: Pick<Position, 'direction' | 'entryPrice' | 'lots'>, exitPrice: number) {
  const difference = (exitPrice - position.entryPrice) * (position.direction === 'buy' ? 1 : -1)
  return { pips: difference / 0.0001, usd: difference * 100_000 * position.lots }
}

export function markPosition(position: Position, quote: Quote | null) {
  if (!quote) return null
  const price = position.direction === 'buy' ? quote.bid.close : quote.ask.close
  return { price, ...grossPnl(position, price) }
}

export function formatTradingNumber(value: number, digits: number): string {
  // Suppress negative zero after rounding, including tiny floating-point errors.
  const rounded = value.toFixed(digits)
  return Number(rounded) === 0 ? (0).toFixed(digits) : rounded
}

export function tradingTime(timestamp: number): string {
  return `${new Date(timestamp).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}
