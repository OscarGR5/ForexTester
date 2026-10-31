import { describe, expect, it } from 'vitest'
import { createTradingState, observeCandle, requestClose, requestCloseAll, requestEntry } from './trading'
import { sessionHistory, manualPermission as permission } from './sessionFixtures'

const history = sessionHistory(8)
function open(count = 2) {
  let state = observeCandle(createTradingState(1, undefined, { roundTripUsdPerLot: 7 }), history.bid[0], history.ask[0])
  for (let i = 0; i < count; i++) state = requestEntry(state, i ? 'sell' : 'buy', i ? .2 : .1, i ? 1.11 : 1.09, permission)
  return observeCandle(state, history.bid[1], history.ask[1])
}

describe('atomic bulk close transition', () => {
  it('queues two closes without mutating the input or other trading records', () => {
    const state = open(), queued = requestCloseAll(state, permission)
    expect(queued.positions.map(p => p.closeRequestedAt)).toEqual([state.observedTimestamp, state.observedTimestamp])
    expect(state.positions.every(p => p.closeRequestedAt === null)).toBe(true)
    expect(queued).toEqual({ ...state, positions: state.positions.map(p => ({ ...p, closeRequestedAt: state.observedTimestamp })) })
    for (const key of ['pending', 'closed', 'setups', 'rejected', 'cancelled', 'quote', 'account', 'commission'] as const) expect(queued[key]).toBe(state[key])
  })

  it('preserves an earlier close request and repeated requests are no-ops', () => {
    let state = open()
    state = requestClose(state, state.positions[0].id, permission)
    // A missing ask delays that existing request while the replay clock advances.
    state = observeCandle(state, history.bid[2])
    const previous = state.positions[0], queued = requestCloseAll(state, permission)
    expect(queued.positions[0]).toBe(previous)
    expect(queued.positions[0].closeRequestedAt).toBe(history.bid[1].timestamp)
    expect(queued.positions[1].closeRequestedAt).toBe(history.bid[2].timestamp)
    expect(requestCloseAll(queued, permission)).toBe(queued)
    const filled = observeCandle(queued, history.bid[3], history.ask[3])
    expect(filled.positions).toHaveLength(0)
    expect(filled.closed.map(p => p.exitTime)).toEqual([history.bid[3].timestamp, history.bid[3].timestamp])
  })

  it('leaves a pending entry untouched, which enters normally when the open position exits', () => {
    let state = open(1)
    state = requestEntry(state, 'sell', .2, 1.11, permission)
    const pending = state.pending, queued = requestCloseAll(state, permission)
    expect(queued.pending).toBe(pending)
    expect(queued.pending[0]).toBe(pending[0])
    const filled = observeCandle(queued, history.bid[2], history.ask[2])
    expect(filled.closed).toHaveLength(1)
    expect(filled.positions).toHaveLength(1)
    expect(filled.positions[0].id).toBe(pending[0].id)
    expect(filled.positions[0].closeRequestedAt).toBeNull()
  })

  it('waits for the next synchronized M1 open and keeps exit sides, fees and PnL', () => {
    const state = open(), queued = requestCloseAll(state, permission)
    expect(observeCandle(queued, history.bid[1], history.ask[1])).toBe(queued)
    const missing = observeCandle(queued, history.bid[2])
    expect(missing.closed).toHaveLength(0)
    const bid = { ...history.bid[3], open: 1.102, high: 1.105, close: 1.104 }
    const ask = { ...history.ask[3], open: 1.1023, high: 1.1053, close: 1.1043 }
    const filled = observeCandle(missing, bid, ask)
    expect(filled.closed.map(p => [p.exitTime, p.exitPrice, p.exitReason])).toEqual([[bid.timestamp, 1.102, 'manual'], [bid.timestamp, 1.1023, 'manual']])
    filled.closed.forEach((p, i) => {
      const gross = (i ? state.positions[i].entryPrice - ask.open : bid.open - state.positions[i].entryPrice) * 100_000 * p.lots
      expect(p.grossPnlUsd).toBeCloseTo(gross, 8)
      expect(p.entryCommissionUsd).toBeCloseTo(3.5 * p.lots, 8)
      expect(p.exitCommissionUsd).toBeCloseTo(3.5 * p.lots, 8)
      expect(p.totalCommissionUsd).toBeCloseTo(7 * p.lots, 8)
      expect(p.netPnlUsd).toBeCloseTo(gross - 7 * p.lots, 8)
    })
    expect(observeCandle(filled, history.bid[4], history.ask[4]).closed).toBe(filled.closed)
  })

  it.each([{ ...permission, active: false }, { ...permission, playing: true }, { ...permission, hasFuture: false }])('obeys permission checks: %o', denied => {
    const state = open()
    expect(requestCloseAll(state, denied)).toBe(state)
  })

  it('requires an observed timestamp and open positions', () => {
    const empty = createTradingState(), state = open()
    expect(requestCloseAll(empty, permission)).toBe(empty)
    const unobserved = { ...state, observedTimestamp: null }
    expect(requestCloseAll(unobserved, permission)).toBe(unobserved)
    const flat = { ...state, positions: [] }
    expect(requestCloseAll(flat, permission)).toBe(flat)
  })
})
