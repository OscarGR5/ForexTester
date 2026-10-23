import { describe, expect, it } from 'vitest'
import type { Candle } from './history'
import { cancelEntry, createTradingState, formatTradingNumber, grossPnl, markPosition, observeCandle, requestClose, requestEntry, validLots, type TradingState } from './trading'

const permission = { active: true, playing: false, hasFuture: true }
const base = Date.UTC(2024, 0, 12, 21, 59)
function bar(minute: number, open = 1.1, close = open): Candle {
  return { timestamp: base + minute * 60_000, open, high: Math.max(open, close) + 0.2, low: 0.9, close }
}
function observe(state: TradingState, minute: number, bid = 1.1, ask = 1.1002) {
  return observeCandle(state, bar(minute, bid), bar(minute, ask))
}
function initial() { return observe(createTradingState(0, { referenceBalance: 100_000, maxRiskPercent: 100 }), 0) }

describe('deterministic EURUSD market execution', () => {
  it('queues both directions without using observed OHLC; fills at next ask/bid open', () => {
    let state = requestEntry(initial(), 'buy', 0.01, 0.5, permission)
    state = requestEntry(state, 'sell', 0.03, 2, permission)
    expect(state.positions).toEqual([])
    expect(observe(state, 0, 2, 3)).toBe(state)
    state = observeCandle(state, bar(1, 1.101, 1.18), bar(1, 1.1013, 1.19))
    expect(state.pending).toEqual([])
    expect(state.positions.map((p) => [p.direction, p.lots, p.entryTime, p.entryPrice])).toEqual([
      ['buy', 0.01, bar(1).timestamp, 1.1013], ['sell', 0.03, bar(1).timestamp, 1.101],
    ])
    expect(new Set(state.positions.map((p) => p.id)).size).toBe(2)
    expect(observe(state, 1)).toBe(state)
    expect(observe(state, 0)).toBe(state)
  })

  it('closes longs at bid open and shorts at ask open with independent lot PnL', () => {
    let state = requestEntry(initial(), 'buy', 0.01, 0.5, permission)
    state = requestEntry(state, 'sell', 0.03, 2, permission)
    state = observe(state, 1, 1.1, 1.1002)
    const [long, short] = state.positions
    state = requestClose(state, long.id, permission)
    state = requestClose(state, short.id, permission)
    expect(requestClose(state, long.id, permission)).toBe(state)
    expect(state.closed).toEqual([])
    expect(observe(state, 1, 2, 3)).toBe(state)
    state = observeCandle(state, bar(2, 1.1012, 1.18), bar(2, 1.1014, 1.19))
    expect(state.positions).toEqual([])
    expect(state.closed.map((p) => [p.exitTime, p.exitPrice])).toEqual([
      [bar(2).timestamp, 1.1012], [bar(2).timestamp, 1.1014],
    ])
    const pnl = state.closed.map((p) => grossPnl(p, p.exitPrice))
    expect(pnl[0].pips).toBeCloseTo(10)
    expect(pnl[0].usd).toBeCloseTo(1)
    expect(pnl[1].pips).toBeCloseTo(-14)
    expect(pnl[1].usd).toBeCloseTo(-4.2)
    expect(observe(state, 3).closed).toEqual(state.closed)
  })

  it('counts pending entries, open positions, and pending closes against the two-position limit', () => {
    let state = requestEntry(initial(), 'buy', 0.01, 0.5, permission)
    state = observe(state, 1)
    state = requestEntry(state, 'sell', 0.02, 2, permission)
    expect(requestEntry(state, 'buy', 0.03, 0.5, permission)).toBe(state)
    state = observe(state, 2)
    state = requestClose(state, state.positions[0].id, permission)
    expect(requestEntry(state, 'buy', 0.03, 0.5, permission)).toBe(state)
    state = observe(state, 3)
    expect(requestEntry(state, 'buy', 0.03, 0.5, permission).pending).toHaveLength(1)
  })

  it('cancels pending entries and frees their slots without reusing IDs', () => {
    let state = requestEntry(initial(), 'buy', 0.01, 0.5, permission)
    const id = state.pending[0].id
    state = cancelEntry(state, id)
    expect(cancelEntry(state, id)).toBe(state)
    expect(observe(state, 1).positions).toEqual([])
    state = requestEntry(state, 'sell', 0.02, 2, permission)
    expect(state.pending[0].id).not.toBe(id)
    state = observe(state, 1)
    expect(cancelEntry(state, state.positions[0].id)).toBe(state)
  })

  it.each([0, -1, NaN, Infinity, -Infinity])('rejects invalid lot volume %s', (lots) => {
    const state = initial()
    expect(validLots(lots)).toBe(false)
    expect(requestEntry(state, 'buy', lots, 0.5, permission)).toBe(state)
  })

  it.each([
    { ...permission, active: false }, { ...permission, playing: true }, { ...permission, hasFuture: false },
  ])('rejects entries and close requests outside paused replay with future bars: %o', (blocked) => {
    const state = initial()
    expect(requestEntry(state, 'buy', 0.01, 0.5, blocked)).toBe(state)
    const open = observe(requestEntry(state, 'buy', 0.01, 0.5, permission), 1)
    expect(requestClose(open, open.positions[0].id, blocked)).toBe(open)
  })

  it('requires a revealed observation and ignores close requests for unknown IDs', () => {
    const state = createTradingState()
    expect(requestEntry(state, 'buy', 0.01, 0.5, permission)).toBe(state)
    expect(requestClose(initial(), 'missing', permission)).toEqual(initial())
  })

  it('waits through missing/unmatched asks for entries and closes, without stale valuations', () => {
    let state = requestEntry(initial(), 'buy', 0.01, 0.5, permission)
    state = observeCandle(state, bar(1))
    state = observeCandle(state, bar(2), bar(3, 1.1004))
    expect(state.pending).toHaveLength(1)
    expect(state.positions).toEqual([])
    state = observe(state, 3, 1.101, 1.1013)
    state = requestClose(state, state.positions[0].id, permission)
    state = observeCandle(state, bar(4))
    expect(state.positions[0].closeRequestedAt).toBe(bar(3).timestamp)
    expect(state.closed).toEqual([])
    expect(markPosition(state.positions[0], state.quote)).toBeNull()
    state = observe(state, 5, 1.102, 1.1025)
    expect(state.closed[0].exitPrice).toBe(1.102)
  })

  it('marks longs to bid close and shorts to ask close, using no future opens or highs/lows', () => {
    let state = requestEntry(initial(), 'buy', 0.01, 0.5, permission)
    state = requestEntry(state, 'sell', 0.02, 2, permission)
    state = observeCandle(state, bar(1, 1.1, 1.101), bar(1, 1.1002, 1.1013))
    const long = markPosition(state.positions[0], state.quote)!
    const short = markPosition(state.positions[1], state.quote)!
    expect(long.price).toBe(1.101)
    expect(long.pips).toBeCloseTo(8)
    expect(long.usd).toBeCloseTo(0.8)
    expect(short.price).toBe(1.1013)
    expect(short.pips).toBeCloseTo(-13)
    expect(short.usd).toBeCloseTo(-2.6)
  })

  it('executes at actual available timestamps across weekend and overnight gaps', () => {
    let state = requestEntry(initial(), 'buy', 0.01, 0.5, permission)
    const sunday = Date.UTC(2024, 0, 14, 23, 59)
    state = observeCandle(state, { ...bar(1), timestamp: sunday }, { ...bar(1, 1.1003), timestamp: sunday })
    expect(state.positions[0].entryTime).toBe(sunday)
    state = requestClose(state, state.positions[0].id, permission)
    const monday = Date.UTC(2024, 0, 15)
    state = observeCandle(state, { ...bar(2, 1.101), timestamp: monday }, { ...bar(2, 1.1012), timestamp: monday })
    expect(state.closed[0].exitTime).toBe(monday)
  })

  it('leaves open positions and unmatched pending entries unfilled at the end of history', () => {
    let state = requestEntry(initial(), 'buy', 0.01, 0.5, permission)
    state = observe(state, 1)
    state = requestClose(state, state.positions[0].id, permission)
    state = requestEntry(state, 'sell', 0.02, 2, permission)
    state = observeCandle(state, bar(2))
    expect(state.positions).toHaveLength(1)
    expect(state.pending).toHaveLength(1)
    expect(state.closed).toEqual([])
    expect(requestEntry(state, 'buy', 0.01, 0.5, { ...permission, hasFuture: false })).toBe(state)
  })

  it('resets all records with a new session and keeps IDs unique across resets', () => {
    const previous = requestEntry(initial(), 'buy', 0.01, 0.5, permission)
    let reset = observe(createTradingState(1), 0)
    expect(reset.pending).toEqual([])
    expect(reset.positions).toEqual([])
    expect(reset.closed).toEqual([])
    reset = requestEntry(reset, 'buy', 0.01, 0.5, permission)
    expect(reset.pending[0].id).not.toBe(previous.pending[0].id)
  })

  it('formats display precision and suppresses negative zero without rounding engine calculations', () => {
    expect(formatTradingNumber(1.100236, 5)).toBe('1.10024')
    expect(formatTradingNumber(-0.0000001, 2)).toBe('0.00')
    expect(formatTradingNumber(1.234, 1)).toBe('1.2')
    const pnl = grossPnl({ direction: 'buy', entryPrice: 1.1, lots: 0.013 }, 1.100234)
    expect(pnl.usd).toBeCloseTo(0.3042)
    expect(formatTradingNumber(pnl.usd, 2)).toBe('0.30')
  })
})
