import { describe, expect, it, vi } from 'vitest'
import type { ISeriesApi } from 'lightweight-charts'
import { EntryLines, ENTRY_COLOR, entryOverlays } from './entryOverlays'
import { cancelEntry, createTradingState, observeCandle, requestAutomaticEntry } from './trading'

const permission = { active: true, playing: false, hasFuture: true }
const candle = { timestamp: 60000, open: 1.1, high: 1.101, low: 1.099, close: 1.1005 }
function pending(direction: 'buy' | 'sell' = 'buy') {
  const state = observeCandle({ ...createTradingState(1), symbol: '6E' }, candle, undefined, 'single')
  const stop = direction === 'buy' ? 1.09 : 1.11
  return requestAutomaticEntry(requestAutomaticEntry(state, direction, .01, stop, permission), direction, .01, stop, permission)
}
function fakeSeries() {
  return { applyOptions: vi.fn(),
    createPriceLine: vi.fn(options => ({ applyOptions: vi.fn(next => Object.assign(options, next)), options: () => options })),
    removePriceLine: vi.fn() }
}

describe('entry references', () => {
  it.each(['buy', 'sell'] as const)('uses compact %s labels through fill and restore, retaining original entry identities', direction => {
    const state = pending(direction), side = direction === 'buy' ? 'B' : 'S'
    expect(entryOverlays(state).map(entry => [entry.price, entry.label])).toEqual([
      [1.1005, `Pending ${side}1 (est.)`], [1.1005, `Pending ${side}2 (est.)`],
    ])
    const second = cancelEntry(state, state.pending[0].id)
    const filled = observeCandle(second, { ...candle, timestamp: 120000, open: 1.1002 }, undefined, 'single')
    const saved = JSON.parse(JSON.stringify(filled))
    expect(entryOverlays(saved)).toEqual([{ id: state.pending[1].id, number: 2, price: 1.1002, pending: false, label: `${side}2` }])
    expect(entryOverlays(observeCandle(saved, { ...candle, timestamp: 180000 }, undefined, 'single'))).toEqual(entryOverlays(saved))
  })
  it('identifies coincident entries on one line and separate fills on two lines, and removes resolved lines', () => {
    const series = fakeSeries(), lines = new EntryLines(series as unknown as ISeriesApi<'Candlestick'>)
    const entries = entryOverlays(pending())
    lines.update(entries)
    expect(series.createPriceLine).toHaveBeenCalledTimes(1)
    expect(series.createPriceLine.mock.results[0].value.options()).toMatchObject({ color: ENTRY_COLOR, lineStyle: 1, title: 'Pending B1 (est.) · Pending B2 (est.)' })
    const filled = entries.map(entry => ({ ...entry, pending: false, label: `B${entry.number}` }))
    lines.update(filled)
    expect(series.createPriceLine.mock.results[0].value.options()).toMatchObject({ lineStyle: 2, title: 'B1 · B2' })
    lines.update([filled[0], { ...filled[1], price: 1.1008 }])
    expect(series.createPriceLine).toHaveBeenCalledTimes(2)
    lines.update([])
    expect(series.removePriceLine).toHaveBeenCalledTimes(2)
    lines.dispose()
  })
  it('includes entries in automatic scaling, preserves margins and returns the original range when flat', () => {
    const series = fakeSeries(), lines = new EntryLines(series as unknown as ISeriesApi<'Candlestick'>)
    lines.update(entryOverlays(pending()))
    const auto = series.applyOptions.mock.calls.at(-1)![0].autoscaleInfoProvider
    const original = { priceRange: { minValue: 1.08, maxValue: 1.09 }, margins: { above: 5, below: 6 } }
    expect(auto(() => original)).toEqual({ ...original, priceRange: { minValue: 1.08, maxValue: 1.1005 } })
    expect(auto(() => null)).toBeNull()
    expect(auto(() => ({ priceRange: null }))).toEqual({ priceRange: null })
    lines.update([])
    expect(series.applyOptions.mock.calls.at(-1)![0].autoscaleInfoProvider(() => original)).toBe(original)
  })
})
