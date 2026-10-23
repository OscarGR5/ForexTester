import { describe, expect, it } from 'vitest'
import type { Candle } from './history'
import { createTradingState, grossPnl, modifyStop, observeCandle, requestClose, requestEntry, stopModificationError, type Direction, type TradingState } from './trading'

const permission = { active: true, playing: false, hasFuture: true }
const base = Date.UTC(2024, 0, 12, 21, 59)
const bar = (minute: number, open = 1.1, low = open - 0.0001, high = open + 0.0001, close = open): Candle =>
  ({ timestamp: base + minute * 60_000, open, low, high, close })
const tick = (state: TradingState, minute: number, bid = bar(minute), ask = bar(minute, 1.1002)) => observeCandle(state, bid, ask)
const initial = () => tick(createTradingState(), 0)
function opened(direction: Direction, stop = direction === 'buy' ? 1.099 : 1.101, lots = 0.02) {
  return tick(requestEntry(initial(), direction, lots, stop, permission), 1)
}

describe('independent stop-loss execution', () => {
  it.each([
    ['buy', bar(2, 1.1, 1.0989), bar(2, 1.1002), 1.099, -12, -2.4],
    ['sell', bar(2), bar(2, 1.1002, 1.1001, 1.1011), 1.101, -10, -2],
  ] as const)('%s stops on its own closing-side extreme at the configured level', (direction, bid, ask, price, pips, usd) => {
    const state = observeCandle(opened(direction), bid, ask)
    expect(state.positions).toHaveLength(0)
    expect(state.closed[0]).toMatchObject({ exitReason: 'stop_loss', stopFillType: 'level', exitPrice: price, exitTime: bar(2).timestamp })
    expect(grossPnl(state.closed[0], price).pips).toBeCloseTo(pips)
    expect(grossPnl(state.closed[0], price).usd).toBeCloseTo(usd)
  })

  it.each(['buy', 'sell'] as const)('%s survives when only the irrelevant side crosses its stop', (direction) => {
    const state = direction === 'buy'
      ? observeCandle(opened(direction), bar(2), bar(2, 1.1002, 1.098))
      : observeCandle(opened(direction), bar(2, 1.1, 1.099, 1.102), bar(2, 1.1002))
    expect(state.positions).toHaveLength(1)
    expect(state.closed).toEqual([])
  })

  it.each([
    ['buy', bar(2, 1.0985), bar(2, 1.0987), 1.0985, -17, -3.4],
    ['sell', bar(2, 1.1013), bar(2, 1.1015), 1.1015, -15, -3],
  ] as const)('%s fills adversely at a gap opening, with PnL based on the fill', (direction, bid, ask, exitPrice, pips, usd) => {
    const state = observeCandle(opened(direction), bid, ask)
    expect(state.closed[0]).toMatchObject({ exitPrice, stopFillType: 'gap_open' })
    expect(grossPnl(state.closed[0], exitPrice).pips).toBeCloseTo(pips)
    expect(grossPnl(state.closed[0], exitPrice).usd).toBeCloseTo(usd)
  })

  it.each(['buy', 'sell'] as const)('activates %s SL immediately in its entry candle', (direction) => {
    const pending = requestEntry(initial(), direction, 0.01, direction === 'buy' ? 1.099 : 1.101, permission)
    const state = observeCandle(pending, bar(1, 1.1, 1.098), bar(1, 1.1002, 1.1001, 1.102))
    expect(state.closed[0].entryTime).toBe(bar(1).timestamp)
    expect(state.closed[0].exitTime).toBe(bar(1).timestamp)
    expect(state.closed[0].entryPrice).toBe(direction === 'buy' ? 1.1002 : 1.1)
    expect(state.closed[0].stopFillType).toBe('level')
    expect(state.positions).toEqual([])
    expect(observeCandle(state, bar(1), bar(1))).toBe(state)
  })

  it('handles two overlapping longs with independent stops and volumes', () => {
    let state = requestEntry(initial(), 'buy', 0.01, 1.099, permission)
    state = requestEntry(state, 'buy', 0.03, 1.098, permission)
    state = tick(state, 1)
    state = observeCandle(state, bar(2, 1.1, 1.0985), bar(2, 1.1002))
    expect(state.closed[0]).toMatchObject({ lots: 0.01, stopPrice: 1.099, exitPrice: 1.099 })
    expect(state.positions[0]).toMatchObject({ lots: 0.03, stopPrice: 1.098 })
    state = observeCandle(state, bar(3, 1.099, 1.0975), bar(3, 1.0992))
    expect(state.closed.map((trade) => grossPnl(trade, trade.exitPrice).usd)).toEqual(expect.arrayContaining([expect.closeTo(-1.2), expect.closeTo(-6.6)]))
    expect(new Set(state.closed.map((trade) => trade.id)).size).toBe(2)
  })

  it('prioritizes an eligible manual exit at the opening over the intrabar stop', () => {
    let state = opened('buy')
    state = requestClose(state, state.positions[0].id, permission)
    state = observeCandle(state, bar(2, 1.1005, 1.098), bar(2, 1.1007))
    expect(state.closed[0]).toMatchObject({ exitReason: 'manual', exitPrice: 1.1005, stopFillType: null })
    expect(tick(state, 3).closed).toHaveLength(1)
  })

  it('protects a pending manual long close even when missing ask blocks that close', () => {
    let state = opened('buy')
    state = requestClose(state, state.positions[0].id, permission)
    state = observeCandle(state, bar(2, 1.1, 1.098))
    expect(state.closed[0]).toMatchObject({ exitReason: 'stop_loss', exitPrice: 1.099, coverageWarnings: [] })
  })

  it('does not assume a pending short close was safe during missing asks, and gaps at recovery', () => {
    let state = opened('sell')
    state = requestClose(state, state.positions[0].id, permission)
    state = observeCandle(state, bar(2))
    state = observeCandle(state, bar(3), { ...bar(3), high: NaN })
    expect(state.positions[0].coverageWarnings).toEqual([{ from: bar(2).timestamp, to: bar(3).timestamp, side: 'ask', reason: 'missing_quote' }])
    // Invalid bid blocks the synchronized manual close, but ask still executes SL.
    state = observeCandle(state, { ...bar(4), low: NaN }, bar(4, 1.102))
    expect(state.closed[0]).toMatchObject({ exitReason: 'stop_loss', exitPrice: 1.102, stopFillType: 'gap_open' })
    expect(state.closed[0].coverageWarnings).toHaveLength(1)
  })

  it('rejects mismatched ask observations and records missing bid stop-side coverage', () => {
    let short = observeCandle(opened('sell'), bar(2), bar(3, 1.2))
    expect(short.closed).toEqual([])
    expect(short.positions[0].coverageWarnings[0].side).toBe('ask')
    short = observeCandle(short, bar(3), bar(3, 1.102))
    expect(short.closed[0].exitPrice).toBe(1.102)
    const long = observeCandle(opened('buy'), { ...bar(2), open: NaN }, bar(2, 1.1002))
    expect(long.positions[0].coverageWarnings[0].side).toBe('bid')
  })

  it('warns about missing clock intervals and fills at the next available weekend opening', () => {
    const sundayMinute = 2 * 24 * 60 + 1
    const state = tick(opened('buy'), sundayMinute, bar(sundayMinute, 1.098), bar(sundayMinute, 1.0982))
    expect(state.closed[0]).toMatchObject({ exitPrice: 1.098, exitTime: bar(sundayMinute).timestamp, stopFillType: 'gap_open' })
    expect(state.closed[0].coverageWarnings).toEqual([{ from: bar(2).timestamp, to: bar(sundayMinute - 1).timestamp, side: 'bid', reason: 'clock_gap' }])
  })

  it.each(['buy', 'sell'] as const)('allows %s break-even and profit SL changes without retroactive execution', (direction) => {
    let state = opened(direction)
    state = tick(state, 2, bar(2, 1.1, 1.0995, 1.103, direction === 'buy' ? 1.102 : 1.0996),
      bar(2, 1.1002, 1.0995, 1.1008, direction === 'buy' ? 1.1002 : 1.0997))
    const id = state.positions[0].id
    const entry = state.positions[0].entryPrice
    state = modifyStop(state, id, entry, permission)
    const profitStop = direction === 'buy' ? 1.101 : 1.0998
    state = modifyStop(state, id, profitStop, permission)
    expect(state.closed).toEqual([])
    expect(state.positions[0].stopModifications).toEqual([
      { oldPrice: direction === 'buy' ? 1.099 : 1.101, newPrice: entry, timestamp: bar(2).timestamp },
      { oldPrice: entry, newPrice: profitStop, timestamp: bar(2).timestamp },
    ])
    expect(observeCandle(state, bar(2), bar(2))).toBe(state)
    state = tick(state, 3, bar(3, 1.1015, 1.1009), bar(3, 1.0997, 1.0996, 1.1))
    expect(state.closed[0]).toMatchObject({ exitPrice: profitStop, stopFillType: 'level' })
    expect(grossPnl(state.closed[0], profitStop).usd).toBeGreaterThan(0)
  })

  it.each([0, -1, NaN, Infinity, -Infinity])('rejects invalid SL input %s at queue and modification', (price) => {
    const state = initial()
    expect(requestEntry(state, 'buy', 0.01, price, permission)).toBe(state)
    const open = opened('buy')
    expect(modifyStop(open, open.positions[0].id, price, permission)).toBe(open)
  })

  it.each(['buy', 'sell'] as const)('rejects %s entry at an invalid actual fill and frees its slot', (direction) => {
    let state = requestEntry(initial(), direction, 0.01, 1.1, permission)
    state = tick(state, 1, bar(1, 1.1), bar(1, 1.1))
    expect(state.pending).toEqual([])
    expect(state.positions).toEqual([])
    expect(state.rejected[0].reason).toContain('actual entry 1.10000')
    expect(requestEntry(state, direction, 0.01, direction === 'buy' ? 1.099 : 1.101, permission).pending).toHaveLength(1)
    expect(tick(state, 2).rejected).toHaveLength(1)
  })

  it('executes short SL on an extreme temporary ask spike despite unchanged bid', () => {
    const state = observeCandle(opened('sell'), bar(2), bar(2, 1.1002, 1.1001, 1.15, 1.1002))
    expect(state.closed[0]).toMatchObject({ exitPrice: 1.101, stopFillType: 'level' })
  })

  it('can stop immediately from opening spread alone', () => {
    const state = tick(requestEntry(initial(), 'sell', 0.01, 1.1001, permission), 1)
    expect(state.closed[0]).toMatchObject({ entryPrice: 1.1, exitPrice: 1.1002, stopFillType: 'gap_open' })
  })

  it('blocks modifications without the required current quote, but does not require the irrelevant side', () => {
    const short = observeCandle(opened('sell'), bar(2))
    expect(stopModificationError(short, short.positions[0], 1.102, permission)).toContain('ask closing quote is unavailable')
    expect(modifyStop(short, short.positions[0].id, 1.102, permission)).toBe(short)
    const long = observeCandle(opened('buy'), bar(2))
    expect(modifyStop(long, long.positions[0].id, 1.0995, permission).positions[0].stopPrice).toBe(1.0995)
  })

  it.each(['buy', 'sell'] as const)('validates %s modified SL strictly against its current closing-side price', (direction) => {
    const state = opened(direction)
    const position = state.positions[0]
    const price = direction === 'buy' ? 1.1 : 1.1002
    expect(modifyStop(state, position.id, price, permission)).toBe(state)
    expect(modifyStop(state, position.id, direction === 'buy' ? price + 0.01 : price - 0.01, permission)).toBe(state)
  })

  it.each([{ ...permission, active: false }, { ...permission, playing: true }, { ...permission, hasFuture: false }])('blocks SL modification outside paused active replay: %o', (blocked) => {
    const state = opened('buy')
    expect(modifyStop(state, state.positions[0].id, 1.0995, blocked)).toBe(state)
  })

  it.each(['buy', 'sell'] as const)('treats a %s opening exactly at SL as a level fill', (direction) => {
    const state = direction === 'buy'
      ? observeCandle(opened(direction), bar(2, 1.099), bar(2, 1.0992))
      : observeCandle(opened(direction), bar(2, 1.1008), bar(2, 1.101))
    expect(state.closed[0].stopFillType).toBe('level')
    expect(state.closed[0].exitPrice).toBe(direction === 'buy' ? 1.099 : 1.101)
  })

  it('retains missing-ask uncertainty when safe prices resume and when the position later closes', () => {
    let state = observeCandle(opened('sell'), bar(2))
    state = tick(state, 3)
    expect(state.positions[0].coverageWarnings).toHaveLength(1)
    expect(state.closed).toEqual([])
    state = requestClose(state, state.positions[0].id, permission)
    state = tick(state, 4)
    expect(state.closed[0].coverageWarnings).toHaveLength(1)
    expect(state.closed[0].exitReason).toBe('manual')
  })

  it('reset removes stops, modifications, closed records, rejections and warnings', () => {
    const state = createTradingState(10)
    expect(state).toMatchObject({ positions: [], pending: [], closed: [], rejected: [], quote: null })
    const previous = opened('buy')
    expect(requestEntry(tick(state, 0), 'buy', 0.01, 1.099, permission).pending[0].id).not.toBe(previous.positions[0].id)
  })
})
