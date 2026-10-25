import { describe, expect, it, vi } from 'vitest'
import { LineStyle, type ISeriesApi, type SeriesAttachedParameter, type IPrimitivePaneRenderer } from 'lightweight-charts'
import { createTradingState, observeCandle, requestAutomaticEntry, cancelEntry, modifyStop, grossPnl, type TradingState } from './trading'
import { STOP_COLOR, stopOverlays } from './stopOverlays'
import { StopLabels, StopLines, stopLabelRows } from './stopLabels'
const permission = { active: true, playing: false, hasFuture: true }
const candle = { timestamp: 60000, open: 1.1, high: 1.1005, low: 1.0999, close: 1.1002 }
function initial() { return observeCandle({ ...createTradingState(1, undefined, { roundTripUsdPerLot: 7 }), symbol: '6E' }, candle, undefined, 'single') }
function pending(two = false) {
  let state = requestAutomaticEntry(initial(), 'buy', .1, 1.099, permission)
  if (two) state = requestAutomaticEntry(state, 'buy', { mode: 'risk', riskPercent: .5 }, 1.0991, permission)
  return state
}
function filled(two = false) { return observeCandle(pending(two), { ...candle, timestamp: 120000 }, undefined, 'single') }
function fakeSeries() {
  return { attachPrimitive: vi.fn(), detachPrimitive: vi.fn(),
    createPriceLine: vi.fn(options => ({ applyOptions: vi.fn(), options: () => options })), removePriceLine: vi.fn() }
}
describe('stop annotations', () => {
  it('shows ordinal, price, existing pip distance and net stop outcome including fees', () => {
    const [stop] = stopOverlays(filled())
    expect(stop.label).toBe('SL 1 · 1.09900 · 10.0 pips · -$10.70')
    expect(stop.pips).toBeCloseTo(10); expect(stop.netUsd).toBeCloseTo(-10.7)
  })
  it('keeps two lines red with explicit distinct labels and visible axis prices', () => {
    const series = fakeSeries(), lines = new StopLines(series as unknown as ISeriesApi<'Candlestick'>)
    const stops = stopOverlays(filled(true)); lines.update(stops)
    expect(stops.map(stop => stop.label)).toEqual([expect.stringMatching(/^SL 1 ·/), expect.stringMatching(/^SL 2 ·/)])
    for (const [options] of series.createPriceLine.mock.calls) expect(options).toMatchObject({ color: STOP_COLOR, title: '', axisLabelVisible: true, lineStyle: LineStyle.Solid })
    lines.dispose(); expect(series.removePriceLine).toHaveBeenCalledTimes(2); expect(series.detachPrimitive).toHaveBeenCalledTimes(1)
  })
  it('updates distance and signed net outcome on modification and drag preview without mutating state', () => {
    const state = filled(), id = state.positions[0].id
    const updated = modifyStop(state, id, 1.0995, permission)
    expect(stopOverlays(updated)[0].label).toBe('SL 1 · 1.09950 · 5.0 pips · -$5.70')
    expect(stopOverlays(state, { id, price: 1.1001 })[0].label).toBe('SL 1 · 1.10010 · 1.0 pips · +$0.30')
    expect(state.positions[0].stopPrice).toBe(1.099)
    expect(stopOverlays(state)[0].netUsd).toBeCloseTo(grossPnl(state.positions[0], 1.099).usd - .7)
  })
  it('retains two confirmed pending stops immediately and reuses their lines at fill', () => {
    const state = pending(true), series = fakeSeries(), lines = new StopLines(series as unknown as ISeriesApi<'Candlestick'>)
    const before = stopOverlays(state); lines.update(before)
    expect(before).toHaveLength(2); expect(before.every(stop => stop.pending)).toBe(true)
    expect(before[0].label).toBe('Pending SL 1 · 1.09900 · ~12.0 pips · est. -$12.70')
    expect(series.createPriceLine.mock.calls.every(([options]) => options.lineStyle === LineStyle.Dashed)).toBe(true)
    const active = stopOverlays(observeCandle(state, { ...candle, timestamp: 120000 }, undefined, 'single')); lines.update(active)
    expect(active.map(stop => [stop.id, stop.number, stop.price])).toEqual(before.map(stop => [stop.id, stop.number, stop.price]))
    expect(active.every(stop => !stop.pending)).toBe(true)
    expect(series.removePriceLine).not.toHaveBeenCalled(); expect(series.createPriceLine).toHaveBeenCalledTimes(2)
    expect(series.createPriceLine.mock.results[0].value.applyOptions).toHaveBeenCalledWith(expect.objectContaining({ lineStyle: LineStyle.Solid }))
  })
  it('removes cancelled or rejected pending lines', () => {
    const state = pending(), series = fakeSeries(), lines = new StopLines(series as unknown as ISeriesApi<'Candlestick'>)
    lines.update(stopOverlays(state)); lines.update(stopOverlays(cancelEntry(state, state.pending[0].id)))
    expect(series.removePriceLine).toHaveBeenCalledTimes(1)
    const rejected = observeCandle(state, { ...candle, timestamp: 120000, open: 1.098, low: 1.097, close: 1.098 }, undefined, 'single')
    expect(rejected.rejected).toHaveLength(1); expect(stopOverlays(rejected)).toEqual([])
  })
  it('does not present pending allocations or unavailable quotes as actual stop outcomes', () => {
    const state = pending(true), stops = stopOverlays(state)
    expect(stops[1].netUsd).toBeLessThan(-state.pending[1].requestedRiskUsd! + 1)
    expect(stops[1].label).toContain('est. -$')
    expect(stopOverlays({ ...state, quote: null })[0].label).toBe('Pending SL 1 · 1.09900 · entry pending')
    expect(stopOverlays({ ...state, quote: { priceModel: 'single', trade: { ...candle, close: 1.098 } } })[0].netUsd).toBeNull()
  })
  it('supports sell-side distances and original bid/ask sessions', () => {
    const state = observeCandle(createTradingState(), candle, { ...candle, open: 1.1003, close: 1.1005, high: 1.1008, low: 1.1002 })
    const requested = requestAutomaticEntry(state, 'sell', .1, 1.101, permission)
    expect(stopOverlays(requested)[0].pips).toBeCloseTo(8)
    const active = observeCandle(requested, { ...candle, timestamp: 120000 }, { ...candle, timestamp: 120000, open: 1.1003, close: 1.1005, high: 1.1008, low: 1.1002 })
    expect(stopOverlays(active)[0].pips).toBeCloseTo(10)
  })
  it('derives all annotations from existing serialized state, including sessions without pending entries', () => {
    const state = pending(true)
    expect(stopOverlays(JSON.parse(JSON.stringify(state)) as TradingState)).toEqual(stopOverlays(state))
    expect(stopOverlays({ ...filled(), pending: [] })[0].label).toContain('SL 1')
  })
})
describe('stop label rendering', () => {
  it.each([0, 1, 50, 99, 100])('separates coincident labels at pane y=%s with exact price anchors', y => {
    const stops = stopOverlays(filled(true)), rows = stopLabelRows(stops, () => y, 100)
    expect(rows[1].center - rows[0].center).toBeGreaterThanOrEqual(25)
    expect(rows[0].center).toBeGreaterThanOrEqual(11); expect(rows[1].center).toBeLessThanOrEqual(89)
    expect(rows.map(row => row.y)).toEqual([y, y])
  })
  it('renders full labels through the chart lifecycle, recomputes coordinates, and hides offscreen stops', () => {
    const labels = new StopLabels(), update = vi.fn(), coordinate = vi.fn((): number | null => 50)
    labels.attached({ series: { priceToCoordinate: coordinate }, requestUpdate: update } as unknown as SeriesAttachedParameter)
    labels.setData(stopOverlays(filled(true)))
    const context = { save: vi.fn(), restore: vi.fn(), measureText: () => ({ width: 300 }), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), fillRect: vi.fn(), fillText: vi.fn() }
    const target = { useMediaCoordinateSpace: (draw: (scope: unknown) => void) => draw({ context, mediaSize: { width: 500, height: 100 } }) } as unknown as Parameters<IPrimitivePaneRenderer['draw']>[0]
    const draw = () => labels.paneViews()[0].renderer()!.draw(target)
    draw(); expect(context.fillText.mock.calls.map(call => call[0])).toEqual(stopOverlays(filled(true)).map(stop => stop.label))
    expect(context.fillText.mock.calls[0][2]).not.toBe(context.fillText.mock.calls[1][2])
    coordinate.mockReturnValue(-10); draw(); expect(context.fillText).toHaveBeenCalledTimes(2)
    coordinate.mockReturnValue(null); draw(); expect(context.fillText).toHaveBeenCalledTimes(2)
    labels.detached(); draw(); expect(update).toHaveBeenCalledTimes(1)
  })
})
