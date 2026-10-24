import { describe, expect, it } from 'vitest'
import { aggregateBidCandles, type TradeCandle } from './history'
import { ReplayBars } from './replayBars'
import { indicatorPreset, indicatorWarmupRequirement } from './indicatorSettings'
import { calculateIndicators } from './indicators'
import { activeSetupId, automaticSetupError, cancelEntry, createTradingState, modifyStop, observeCandle, requestAutomaticEntry, requestClose, requestEntry, stopModificationError } from './trading'
import { defaultWorkspace, validWorkspace } from './uiPreferences'
import { stopHitCandidates } from './useStopDrag'
const permission = { active: true, playing: false, hasFuture: true }
const base = Date.UTC(2024, 0, 5)
const bar = (day: number, close = 1.1, instrumentId = 1): TradeCandle => ({ timestamp: base + day * 86400000, open: 1.1, high: Math.max(1.11, close), low: Math.min(1.09, close), close, volume: '1', instrumentId })
const initial = () => observeCandle({ ...createTradingState(1), symbol: '6E' }, bar(0), undefined, 'single')
const observe = (state: ReturnType<typeof initial>, minute: number) => observeCandle(state, { ...bar(0), timestamp: base + minute * 60000 }, undefined, 'single')

describe('automatic discretionary setups', () => {
  it('creates one setup, joins two same-direction entries, rejects conflicts and starts another after resolution', () => {
    let s = requestAutomaticEntry(initial(), 'buy', 0.01, 1.05, permission)
    const first = activeSetupId(s)
    expect(requestAutomaticEntry(s, 'sell', 0.01, 1.15, permission)).toBe(s)
    s = requestAutomaticEntry(s, 'buy', 0.01, 1.04, permission)
    expect(s.setups).toHaveLength(1); expect(s.pending.map(p => p.setupId)).toEqual([first, first])
    s = observe(s, 1); expect(s.positions).toHaveLength(2)
    s = requestClose(s, s.positions[0].id, permission); s = observe(s, 2)
    expect(s.closed).toHaveLength(1); expect(s.positions).toHaveLength(1)
    expect(requestAutomaticEntry(s, 'buy', 0.01, 1.05, permission)).toBe(s)
    s = requestClose(s, s.positions[0].id, permission); s = observe(s, 3)
    s = requestAutomaticEntry(s, 'sell', 0.01, 1.15, permission)
    expect(s.setups).toHaveLength(2); expect(activeSetupId(s)).not.toBe(first)
    expect(s.closed.every(p => p.setupId === first)).toBe(true)
  })
  it('counts cancelled submitted slots while the other entry remains active', () => {
    let s = requestAutomaticEntry(initial(), 'buy', 0.01, 1.05, permission)
    s = requestAutomaticEntry(s, 'buy', 0.01, 1.04, permission)
    s = cancelEntry(s, s.pending[0].id)
    expect(automaticSetupError(s, 'buy', activeSetupId(s))).toMatch(/both submitted/)
    expect(requestAutomaticEntry(s, 'buy', 0.01, 1.05, permission)).toBe(s)
    s = cancelEntry(s, s.pending[0].id)
    expect(requestAutomaticEntry(s, 'sell', 0.01, 1.15, permission).setups).toHaveLength(2)
  })
  it('leaves recoverable legacy concurrent setups intact and blocks new workflow submissions', () => {
    let s = requestEntry(initial(), 'buy', 0.01, 1.05, permission)
    s = requestEntry(s, 'sell', 0.01, 1.15, permission)
    const before = structuredClone(s)
    expect(requestAutomaticEntry(s, 'buy', 0.01, 1.05, permission)).toBe(s)
    expect(s).toEqual(before); expect(s.setups).toHaveLength(2)
  })
})

describe('stop drag engine boundary', () => {
  it.each(['buy', 'sell'] as const)('validates %s previews and commits one effective-after-current observation history record', direction => {
    let s = requestAutomaticEntry(initial(), direction, 0.01, direction === 'buy' ? 1.05 : 1.15, permission)
    s = observe(s, 1); const p = s.positions[0], price = direction === 'buy' ? 1.07 : 1.13
    expect(stopModificationError(s, p, price, permission)).toBeNull()
    expect(stopModificationError(s, p, direction === 'buy' ? 1.11 : 1.09, permission)).toMatch(/must be/)
    expect(modifyStop(s, p.id, price, { ...permission, playing: true })).toBe(s)
    expect(modifyStop(s, p.id, price, { ...permission, hasFuture: false })).toBe(s)
    const changed = modifyStop(s, p.id, price, permission).positions[0]
    expect(changed.stopEffectiveAfter).toBe(s.observedTimestamp)
    expect(changed.stopModifications).toEqual([{ oldPrice: p.stopPrice, newPrice: price, timestamp: s.observedTimestamp }])
    expect(s.positions[0].stopPrice).toBe(p.stopPrice)
  })
  it('rejects combined risk excess and identifies coincident stops by position ID', () => {
    let s = requestAutomaticEntry(initial(), 'buy', 0.1, 1.05, permission)
    s = requestAutomaticEntry(s, 'buy', 0.1, 1.05, permission); s = observe(s, 1)
    expect(s.positions).toHaveLength(2)
    expect(stopModificationError(s, s.positions[0], 0.5, permission)).toMatch(/combined risk/)
    expect(stopHitCandidates(s.positions, 101, () => 100).map(p => p.id)).toEqual(s.positions.map(p => p.id))
    expect(stopHitCandidates(s.positions, 108, () => 100)).toEqual([])
    const next = modifyStop(s, s.positions[1].id, 1.07, permission)
    expect(next.positions[0]).toBe(s.positions[0]); expect(next.positions[1].stopPrice).toBe(1.07)
  })
})

describe('revealed D1 chart data', () => {
  it('uses UTC boundaries, first real open, revealed close, weekends as gaps and separate contracts', () => {
    const source = [bar(0), { ...bar(0, 1.12), timestamp: base + 3600000, high: 1.14 }, bar(3),
      { ...bar(3, 1.13, 2), timestamp: base + 3 * 86400000 + 60000 }]
    const bars = new ReplayBars('D1')
    for (let count = 1; count <= source.length; count++) {
      bars.advance(source, count)
      expect(bars.candles).toEqual(aggregateBidCandles(source.slice(0, count), 'D1').map(({ timestamp, open, high, low, close }) => ({ time: timestamp / 1000, open, high, low, close })))
    }
    expect(bars.candles.map(c => c.time)).toEqual([base / 1000, (base + 3 * 86400000) / 1000, (base + 3 * 86400000 + 60000) / 1000])
    expect(bars.candles[0]).toMatchObject({ open: 1.1, high: 1.14, low: 1.09, close: 1.12 })
  })
  it('requires 78 completed daily observations for standard Ichimoku and never reads beyond the revealed prefix', () => {
    const settings = indicatorPreset('D1'); expect(settings.ichimoku).toEqual({ enabled: true, tenkan: 9, kijun: 26, spanB: 52, displacement: 26 })
    expect(indicatorWarmupRequirement(settings)).toBe(78)
    const source = Array.from({ length: 90 }, (_, day) => bar(day, 1.1 + day * 0.0001)), bars = new ReplayBars('D1')
    bars.advance(source, 30)
    const before = calculateIndicators(bars.candles, settings, 'D1')
    expect(bars.candles).toHaveLength(30); expect(before.spanB).toEqual([])
    source[50].high = 100
    expect(calculateIndicators(bars.candles, settings, 'D1')).toEqual(before)
    bars.advance(source, 79); expect(bars.candles.length - 1).toBe(78)
    expect(calculateIndicators(bars.candles, settings, 'D1').cloud.length).toBeGreaterThan(0)
  })
  it('defaults new charts to H1 and accepts legacy M1 workspace and old shared viewport', () => {
    const workspace = defaultWorkspace(); expect(workspace.timeframes[0]).toBe('H1')
    expect(validWorkspace({ ...workspace, timeframes: ['M1', 'M5', 'H1'], indicators: [{ M1: indicatorPreset('M1') }, { M5: indicatorPreset('M5') }, { H1: indicatorPreset('H1') }], viewport: { range: { from: 1, to: 2 }, following: false } })).toBe(true)
  })
})
