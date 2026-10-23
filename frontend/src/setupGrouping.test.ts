import { describe, expect, it } from 'vitest'
import { cancelEntry, createTradingState, modifyStop, observeCandle, requestClose, requestEntry, setupAssignmentError, setupStatus, updateSetupMetadata, type TradingState } from './trading'

const permission = { active: true, playing: false, hasFuture: true }
const base = Date.UTC(2024, 0, 9)
function observe(state: TradingState, minute: number, bidPrice = 1.1) {
  const bid = { timestamp: base + minute * 60_000, open: bidPrice, high: bidPrice + 0.0001, low: bidPrice - 0.0001, close: bidPrice }
  const ask = { ...bid, open: bid.open + 0.0002, high: bid.high + 0.0002, low: bid.low + 0.0002, close: bid.close + 0.0002 }
  return observeCandle(state, bid, ask)
}
const initial = () => observe(createTradingState(), 0)

describe('explicit setup grouping', () => {
  it('creates separate setups by default even for simultaneous entries', () => {
    let state = requestEntry(initial(), 'buy', 0.01, 1.09, permission)
    state = requestEntry(state, 'buy', 0.02, 1.095, permission)
    expect(state.setups).toHaveLength(2)
    expect(state.pending.map((entry) => entry.setupId)).toEqual(state.setups.map((setup) => setup.id))
    const pending = state.pending
    state = observe(state, 1)
    expect(state.positions.map(({ id, setupId }) => ({ id, setupId }))).toEqual(pending.map(({ id, setupId }) => ({ id, setupId })))
    expect(state.positions.map((entry) => [entry.lots, entry.initialStopPrice])).toEqual([[0.01, 1.09], [0.02, 1.095]])
  })

  it('joins pending or open entries and enforces matching direction and two submitted slots', () => {
    let state = requestEntry(initial(), 'buy', 0.01, 1.09, permission)
    const id = state.setups[0].id
    expect(setupStatus(state, id)).toBe('pending')
    expect(requestEntry(state, 'sell', 0.01, 1.11, permission, id)).toBe(state)
    expect(requestEntry(state, 'buy', 0.01, 1.09, permission, 'missing')).toBe(state)
    state = requestEntry(state, 'buy', 0.02, 1.095, permission, id)
    expect(state.setups).toHaveLength(1)
    expect(state.pending.every((entry) => entry.setupId === id)).toBe(true)
    expect(setupAssignmentError(state, 'buy', id)).toContain('two submitted')
    state = observe(state, 1)
    expect(setupStatus(state, id)).toBe('open')
    state = requestClose(state, state.positions[0].id, permission)
    expect(setupStatus(state, id)).toBe('open')
    state = observe(state, 2)
    expect(setupStatus(state, id)).toBe('partially closed')
    expect(requestEntry(state, 'buy', 0.01, 1.09, permission, id)).toBe(state)
    // A closed member still consumes its setup slot, while the global slot is free.
    state = requestEntry(state, 'sell', 0.01, 1.11, permission)
    expect(state.pending).toHaveLength(1)
    state = requestClose(state, state.positions[0].id, permission)
    state = observe(state, 3)
    expect(setupStatus(state, id)).toBe('completed')
    expect(requestEntry(state, 'buy', 0.01, 1.09, permission, id)).toBe(state)
    expect(state.closed.every((entry) => entry.setupId === id)).toBe(true)
  })

  it('releases cancelled and rejected slots without losing association or reusing IDs', () => {
    let state = requestEntry(initial(), 'buy', 0.01, 1.09, permission)
    const setupId = state.setups[0].id
    const firstId = state.pending[0].id
    state = observe(state, 1)
    state = requestEntry(state, 'buy', 0.02, 1.095, permission, setupId)
    const cancelledId = state.pending[0].id
    state = cancelEntry(state, cancelledId)
    expect(state.cancelled[0]).toMatchObject({ id: cancelledId, setupId, cancelledAt: base + 60_000 })
    state = requestEntry(state, 'buy', 0.02, 1.101, permission, setupId)
    const rejectedId = state.pending[0].id
    state = observe(state, 2)
    expect(state.rejected[0]).toMatchObject({ id: rejectedId, setupId })
    expect(setupStatus(state, setupId)).toBe('open')
    state = requestEntry(state, 'buy', 0.03, 1.095, permission, setupId)
    expect(new Set([firstId, cancelledId, rejectedId, state.pending[0].id]).size).toBe(4)
    state = requestClose(state, firstId, permission)
    // A missing ask leaves both the close and entry pending; the setup is incomplete.
    const bid = { timestamp: base + 180_000, open: 1.1, high: 1.1001, low: 1.0999, close: 1.1 }
    state = observeCandle(state, bid)
    expect(setupStatus(state, setupId)).toBe('open')
    state = observe(state, 4)
    expect(setupStatus(state, setupId)).toBe('partially closed')
    expect(state.positions[0].lots).toBe(0.03)
  })

  it('never treats unexecuted rejected/cancelled setups as completed or joinable', () => {
    let state = requestEntry(initial(), 'buy', 0.01, 1.101, permission)
    const rejectedSetup = state.pending[0].setupId
    state = observe(state, 1)
    state = requestEntry(state, 'buy', 0.01, 1.09, permission)
    const cancelledSetup = state.pending[0].setupId
    state = cancelEntry(state, state.pending[0].id)
    expect(state.closed).toEqual([])
    for (const id of [rejectedSetup, cancelledSetup]) {
      expect(setupStatus(state, id)).toBe('rejected/cancelled')
      expect(requestEntry(state, 'buy', 0.01, 1.09, permission, id)).toBe(state)
    }
  })

  it('remains partially closed while a missing quote leaves a second entry pending', () => {
    let state = requestEntry(initial(), 'buy', 0.01, 1.09, permission)
    const setupId = state.pending[0].setupId
    state = observe(state, 1)
    state = requestEntry(state, 'buy', 0.02, 1.095, permission, setupId)
    state = observeCandle(state, { timestamp: base + 120_000, open: 1.08, high: 1.081, low: 1.079, close: 1.08 })
    expect(state.closed).toHaveLength(1)
    expect(state.pending).toHaveLength(1)
    expect(setupStatus(state, setupId)).toBe('partially closed')
    state = cancelEntry(state, state.pending[0].id)
    expect(setupStatus(state, setupId)).toBe('completed')
  })

  it('preserves immutable journal records when only the observed quote changes', () => {
    let state = requestEntry(initial(), 'buy', 0.01, 1.09, permission)
    state = observe(state, 1)
    const next = observe(state, 2)
    expect(next.quote).not.toBe(state.quote)
    expect(next.positions).toBe(state.positions)
    expect(next.closed).toBe(state.closed)
    expect(next.rejected).toBe(state.rejected)
    expect(next.pending).toBe(state.pending)
    expect(next.setups).toBe(state.setups)
  })

  it('retains original SL and risk through changes and supports metadata edits after closure', () => {
    let state = requestEntry(initial(), 'buy', 0.01, 1.09, permission)
    const setupId = state.pending[0].setupId
    state = observe(state, 1)
    const originalRisk = state.positions[0].initialRiskUsd
    const positionId = state.positions[0].id
    state = modifyStop(state, positionId, 1.095, permission)
    state = requestClose(state, positionId, permission)
    state = observe(state, 2)
    const closed = state.closed
    expect(closed[0]).toMatchObject({ initialStopPrice: 1.09, stopPrice: 1.095, initialRiskUsd: originalRisk, setupId })
    const metadata = { title: 'London entry', tag: 'Free text model', notes: 'Review after close\nSecond line' }
    state = updateSetupMetadata(state, setupId, metadata)
    expect(state.setups[0]).toMatchObject(metadata)
    expect(state.closed).toBe(closed)
    const reset = createTradingState(1, state.account, state.commission)
    expect(reset.setups).toEqual([])
    expect(reset.cancelled).toEqual([])
  })
})
