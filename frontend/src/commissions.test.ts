import { describe, expect, it } from 'vitest'
import { commissionConfigError, perSideCommissionUsd } from './commissions'
import type { Candle } from './history'
import { cancelEntry, combinedRisk, configureCommission, createTradingState, grossPnl, markPosition, modifyStop, observeCandle, realizedSummary, requestClose, requestEntry, stopLossEstimates, type TradingState } from './trading'

const permission = { active: true, playing: false, hasFuture: true }
const ready = { ...permission, active: false }
const config = { roundTripUsdPerLot: 7 }
const candle = (minute: number, open: number, low = open, high = open, close = open): Candle =>
  ({ timestamp: Date.UTC(2024, 0, 9) + minute * 60_000, open, low, high, close })
const tick = (state: TradingState, minute: number, bid = 1.1, ask = 1.1002) => observeCandle(state, candle(minute, bid), candle(minute, ask))
const initial = (rate = 7) => tick(createTradingState(0, undefined, { roundTripUsdPerLot: rate }), 0)
const buy = (state = initial(), lots = 2, stop = 1.0982) => requestEntry(state, 'buy', lots, stop, permission)
const close = (state: TradingState, minute: number, bid: number, ask = bid + 0.0002) =>
  tick(requestClose(state, state.positions[0].id, permission), minute, bid, ask)

describe('USD round-trip configuration and per-side arithmetic', () => {
  it.each([0, 7, 7.25, Number.MAX_VALUE])('accepts finite nonnegative rate %s', (roundTripUsdPerLot) => {
    expect(commissionConfigError({ roundTripUsdPerLot })).toBeNull()
    expect(configureCommission(createTradingState(), { roundTripUsdPerLot }, ready).commission.roundTripUsdPerLot).toBe(roundTripUsdPerLot)
  })
  it.each([-1, NaN, Infinity, -Infinity])('rejects invalid rate %s without changing configuration', (roundTripUsdPerLot) => {
    const state = createTradingState()
    expect(commissionConfigError({ roundTripUsdPerLot })).toContain('USD')
    expect(configureCommission(state, { roundTripUsdPerLot }, ready)).toBe(state)
    expect(() => createTradingState(0, undefined, { roundTripUsdPerLot })).toThrow('USD')
  })
  it('defaults to $7 round trip and charges $7 per side for 2 lots, retaining sub-cent precision', () => {
    expect(perSideCommissionUsd(2, config)).toBe(7)
    expect(perSideCommissionUsd(0.013, { roundTripUsdPerLot: 7.25 })).toBeCloseTo(0.047125, 12)
    expect(createTradingState().commission.roundTripUsdPerLot).toBe(7)
  })
  it('locks settings for paused, playing, and completed active replay', () => {
    for (const blocked of [permission, { ...permission, playing: true }, { ...permission, hasFuture: false }]) {
      const state = initial()
      expect(configureCommission(state, { roundTripUsdPerLot: 20 }, blocked)).toBe(state)
    }
    const open = tick(buy(), 1)
    expect(configureCommission(open, config, ready)).toBe(open)
    const pending = buy()
    expect(configureCommission(pending, config, ready)).toBe(pending)
  })
})

describe('execution fees and independently stored realized PnL', () => {
  it('keeps zero-commission PnL equal to gross', () => {
    const state = close(tick(buy(initial(0)), 1), 2, 1.1012)
    expect(state.closed[0]).toMatchObject({ entryCommissionUsd: 0, exitCommissionUsd: 0, totalCommissionUsd: 0 })
    expect(state.closed[0].grossPnlUsd).toBeCloseTo(200)
    expect(state.closed[0].netPnlUsd).toBeCloseTo(200)
  })
  it.each([
    [1.1012, 200, 186, 10], [1.0992, -200, -214, -10], [1.1002, 0, -14, 0],
  ])('manually closes at %s with gross %s and net %s, keeping price pips unchanged', (price, gross, net, pips) => {
    const queued = buy()
    expect(queued.positions).toHaveLength(0)
    expect(realizedSummary(queued.closed).totalCommissionUsd).toBe(0)
    const open = tick(queued, 1)
    expect(open.positions[0].entryCommissionUsd).toBe(7)
    expect(open.positions[0]).not.toHaveProperty('exitCommissionUsd')
    const requested = requestClose(open, open.positions[0].id, permission)
    expect(requested.closed).toHaveLength(0)
    const state = tick(requested, 2, price, price + 0.0002)
    expect(state.closed[0]).toMatchObject({ entryCommissionUsd: 7, exitCommissionUsd: 7, totalCommissionUsd: 14, exitReason: 'manual' })
    expect(state.closed[0].grossPnlUsd).toBeCloseTo(gross)
    expect(state.closed[0].netPnlUsd).toBeCloseTo(net)
    expect(grossPnl(state.closed[0], price).pips).toBeCloseTo(pips)
  })
  it('charges the spread through bid/ask fills exactly once', () => {
    const state = close(tick(buy(), 1), 2, 1.1)
    // 1.10000 bid minus 1.10020 ask = -2 pips; 2 lots = -$40.
    expect(state.closed[0].grossPnlUsd).toBeCloseTo(-40)
    expect(state.closed[0].netPnlUsd).toBeCloseTo(-54)
  })
  it('charges entry and automatic level SL exactly once on the same candle', () => {
    const queued = buy()
    const bid = candle(1, 1.1, 1.098, 1.1)
    const ask = candle(1, 1.1002)
    const state = observeCandle(queued, bid, ask)
    expect(state.positions).toHaveLength(0)
    expect(state.closed[0]).toMatchObject({ entryTime: bid.timestamp, exitTime: bid.timestamp,
      exitReason: 'stop_loss', stopFillType: 'level', exitPrice: 1.0982, entryCommissionUsd: 7, exitCommissionUsd: 7, totalCommissionUsd: 14 })
    expect(state.closed[0].grossPnlUsd).toBeCloseTo(-400)
    expect(state.closed[0].netPnlUsd).toBeCloseTo(-414)
    expect(observeCandle(state, bid, ask)).toBe(state)
    expect(observeCandle(queued, bid, ask)).toEqual(state) // Pure transition replay.
    expect(tick(state, 2).closed).toEqual(state.closed)
  })
  it('charges an automatic adverse gap using actual fill PnL', () => {
    const state = tick(tick(buy(), 1), 5, 1.097, 1.0972)
    expect(state.closed[0]).toMatchObject({ exitPrice: 1.097, exitReason: 'stop_loss', stopFillType: 'gap_open', totalCommissionUsd: 14 })
    expect(state.closed[0].grossPnlUsd).toBeCloseTo(-640)
    expect(state.closed[0].netPnlUsd).toBeCloseTo(-654)
  })
  it('charges a short ask-spike SL independently from the bid chart', () => {
    let state = tick(requestEntry(initial(), 'sell', 1, 1.102, permission), 1)
    state = observeCandle(state, candle(2, 1.1), candle(2, 1.1002, 1.1002, 1.1025))
    expect(state.closed[0]).toMatchObject({ exitPrice: 1.102, totalCommissionUsd: 7, exitReason: 'stop_loss' })
    expect(state.closed[0].grossPnlUsd).toBeCloseTo(-200)
    expect(state.closed[0].netPnlUsd).toBeCloseTo(-207)
  })
  it('preserves manual opening priority over that candle’s automatic stop', () => {
    const open = tick(buy(), 1)
    const state = observeCandle(requestClose(open, open.positions[0].id, permission), candle(2, 1.1012, 1.097, 1.1012), candle(2, 1.1014))
    expect(state.closed).toHaveLength(1)
    expect(state.closed[0]).toMatchObject({ exitReason: 'manual', exitPrice: 1.1012, totalCommissionUsd: 14 })
    expect(state.closed[0].netPnlUsd).toBeCloseTo(186)
  })
  it('keeps different volumes independent through different exits and aggregates only closed fees', () => {
    let state = requestEntry(buy(), 'sell', 0.5, 1.102, permission)
    state = tick(state, 1)
    expect(state.positions.map(p => p.entryCommissionUsd)).toEqual([7, 1.75])
    state = close(state, 2, 1.1012)
    expect(state.positions[0].lots).toBe(0.5)
    expect(realizedSummary(state.closed)).toMatchObject({ count: 1, totalCommissionUsd: 14 })
    state = tick(state, 3, 1.1028, 1.103)
    expect(state.closed.map(p => p.totalCommissionUsd)).toEqual([14, 3.5])
    expect(state.closed[1].netPnlUsd).toBeCloseTo(-153.5)
    const summary = realizedSummary(state.closed)
    expect(summary.count).toBe(2)
    expect(summary.grossPnlUsd).toBeCloseTo(50)
    expect(summary.totalCommissionUsd).toBe(17.5)
    expect(summary.netPnlUsd).toBeCloseTo(32.5)
  })
  it('charges nothing for cancellation, missing entry quotes, invalid SL or rejected risk', () => {
    const pending = observeCandle(buy(), candle(1, 1.1))
    expect(pending.positions).toHaveLength(0)
    const cancelled = tick(cancelEntry(pending, pending.pending[0].id), 2)
    expect(cancelled.positions).toHaveLength(0)
    const invalidStop = tick(buy(initial(), 2, 1.101), 1)
    const invalidRisk = tick(buy(initial(), 20), 1)
    for (const state of [invalidStop, invalidRisk]) {
      expect(state.rejected).toHaveLength(1)
      expect(state.rejected[0]).not.toHaveProperty('entryCommissionUsd')
      expect(state.positions).toHaveLength(0)
      expect(realizedSummary(state.closed).totalCommissionUsd).toBe(0)
    }
  })
  it('rejects a fill whose fees overflow without charging entry commission', () => {
    const state = tick(buy(initial(Number.MAX_VALUE)), 1)
    expect(state.positions).toHaveLength(0)
    expect(state.closed).toHaveLength(0)
    expect(state.rejected[0].reason).toContain('Commission cannot be represented safely')
    expect(state.rejected[0]).not.toHaveProperty('entryCommissionUsd')
  })
  it('copies configuration and retains stored historical fees after later changes', () => {
    const rate = { roundTripUsdPerLot: 7 }
    let state = tick(createTradingState(0, undefined, rate), 0)
    rate.roundTripUsdPerLot = 99
    state = close(tick(buy(state), 1), 2, 1.1012)
    const changed = configureCommission(state, { roundTripUsdPerLot: 20 }, ready)
    expect(changed.closed[0].totalCommissionUsd).toBe(14)
    expect(changed.closed[0].commission.roundTripUsdPerLot).toBe(7)
    expect(changed.closed[0].netPnlUsd).toBeCloseTo(186)
  })
})

describe('open valuation and gross risk remain separate from fees', () => {
  it.each(['buy', 'sell'] as const)('marks %s using current closing-side quotes and estimates both fees', direction => {
    let state = requestEntry(initial(), direction, 2, direction === 'buy' ? 1.0982 : 1.102, permission)
    state = tick(state, 1)
    state = observeCandle(state, candle(2, 1.1005, 1.1005, 1.1012, 1.1012), candle(2, 1.1007, 1.1007, 1.1014, 1.1014))
    const mark = markPosition(state.positions[0], state.quote)!
    expect(mark.price).toBe(direction === 'buy' ? 1.1012 : 1.1014)
    expect(mark.usd).toBeCloseTo(direction === 'buy' ? 200 : -280)
    expect(mark.estimatedExitCommissionUsd).toBe(7)
    expect(mark.estimatedNetPnlUsd).toBeCloseTo(direction === 'buy' ? 186 : -294)
    expect(state.closed).toHaveLength(0)
  })
  it('retains only the incurred entry fee at missing final quotes without manufacturing an exit', () => {
    let state = tick(buy(), 1)
    state = requestClose(state, state.positions[0].id, permission)
    state = observeCandle(state, candle(2, 1.1), candle(1, 1.1002))
    expect(markPosition(state.positions[0], state.quote)).toBeNull()
    expect(state.positions[0].entryCommissionUsd).toBe(7)
    expect(state.positions[0]).not.toHaveProperty('exitCommissionUsd')
    expect(state.closed).toHaveLength(0)
    expect(realizedSummary(state.closed)).toEqual({ count: 0, grossPnlUsd: 0, totalCommissionUsd: 0, netPnlUsd: 0 })
  })
  it('leaves risk and manual lots unchanged even when fees take estimated loss beyond the gross cap', () => {
    let state = requestEntry(initial(), 'buy', { mode: 'risk', riskPercent: 1 }, 1.0982, permission)
    state = requestEntry(state, 'buy', 5, 1.0982, permission)
    expect(combinedRisk(state).reservedUsd).toBe(1000)
    state = tick(state, 1)
    expect(state.positions.map(p => p.lots)).toEqual([5, 5])
    expect(state.positions.map(p => p.mode)).toEqual(['risk', 'manual'])
    expect(combinedRisk(state).openUsd).toBeCloseTo(2000)
    expect(combinedRisk(state).remainingUsd).toBeCloseTo(0)
    for (const position of state.positions) {
      expect(position.initialRiskUsd).toBeCloseTo(1000)
      expect(position.initialRiskPercent).toBeCloseTo(1)
      expect(stopLossEstimates(position).initialLossUsd).toBeCloseTo(1035)
      expect(stopLossEstimates(position).currentLossUsd).toBeCloseTo(1035)
    }
  })
  it('uses net downside at a modified SL, allowing profit to cover fees without changing original risk', () => {
    let state = tick(buy(), 1)
    state = tick(state, 2, 1.102, 1.1022)
    const id = state.positions[0].id
    state = modifyStop(state, id, 1.1002, permission)
    expect(combinedRisk(state).openUsd).toBe(0)
    expect(stopLossEstimates(state.positions[0]).currentLossUsd).toBe(14)
    state = modifyStop(state, id, 1.10025, permission)
    expect(stopLossEstimates(state.positions[0]).currentLossUsd).toBeCloseTo(4)
    state = modifyStop(state, id, 1.101, permission)
    expect(stopLossEstimates(state.positions[0]).currentLossUsd).toBe(0)
    expect(stopLossEstimates(state.positions[0]).initialLossUsd).toBeCloseTo(414)
    expect(state.positions[0].initialRiskUsd).toBeCloseTo(400)
  })
})
