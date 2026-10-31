import { expect, it, vi } from 'vitest'
import type { IPrimitivePaneRenderer, SeriesAttachedParameter, UTCTimestamp } from 'lightweight-charts'
import { executionLogical, TradeOverlays, tradeOverlayRecords } from './tradeOverlays'
import { createTradingState, modifyStop, observeCandle, requestAutomaticEntry, requestClose } from './trading'
import { TIMEFRAMES, TIMEFRAME_MS } from './history'
import type { ChartCandle } from './indicators'

const permission = { active: true, playing: false, hasFuture: true }
const candle = { timestamp: 60000, open: 1.1, high: 1.1005, low: 1.0999, close: 1.1002 }
function fixture(direction: 'buy' | 'sell' = 'buy', modifications = 2) {
  let state = observeCandle(createTradingState(), candle, undefined, 'single')
  const stop = direction === 'buy' ? 1.09 : 1.11
  state = requestAutomaticEntry(state, direction, .01, stop, permission)
  state = requestAutomaticEntry(state, direction, .01, stop, permission)
  expect(tradeOverlayRecords(state.positions, state.closed)).toEqual([])
  state = observeCandle(state, { ...candle, timestamp: 120000 }, undefined, 'single')
  state = observeCandle(state, { ...candle, timestamp: 180000 }, undefined, 'single')
  if (modifications >= 1) state = modifyStop(state, state.positions[0].id, stop + .0001, permission)
  state = observeCandle(state, { ...candle, timestamp: 240000 }, undefined, 'single')
  if (modifications >= 2) state = modifyStop(state, state.positions[0].id, stop + .0002, permission)
  return state
}
function bars(times: number[]): ChartCandle[] { return times.map(time => ({ time: time as UTCTimestamp, open: 1.1, high: 1.11, low: 1.09, close: 1.1 })) }

it.each(['buy', 'sell'] as const)('uses real %s fills, one fixed original SL and no fabricated open exit, also after restore', direction => {
  const state = fixture(direction), before = JSON.stringify(state)
  const records = tradeOverlayRecords(state.positions, state.closed)
  expect(records).toHaveLength(2)
  expect(records[0].entry).toEqual({ timestamp: 120000, price: 1.1, direction })
  expect(records[0].exit).toBeNull()
  expect(records[0].originalStop).toEqual({ price: state.positions[0].initialStopPrice, modifiedAt: 180000 })
  expect(records[1].originalStop).toBeNull()
  expect(JSON.stringify(state)).toBe(before)
  const closed = observeCandle(requestClose(state, state.positions[0].id, permission), { ...candle, timestamp: 300000, open: 1.1003 }, undefined, 'single')
  const restored = JSON.parse(JSON.stringify(closed))
  const result = tradeOverlayRecords(restored.positions, restored.closed)
  expect(result.find(r => r.id === records[0].id)?.exit).toEqual({ timestamp: 300000, price: 1.1003, direction: direction === 'buy' ? 'sell' : 'buy' })
  expect(result.find(r => r.id === records[0].id)?.originalStop).toEqual(records[0].originalStop)
  expect(result.find(r => r.id === records[1].id)?.exit).toBeNull()
})

it.each(['buy', 'sell'] as const)('creates the %s original reference only on the first modification and keeps it when SL returns to its initial price', direction => {
  let state = fixture(direction, 0)
  const [first, second] = state.positions
  expect(tradeOverlayRecords(state.positions, state.closed).map(r => r.originalStop)).toEqual([null, null])
  state = modifyStop(state, first.id, first.stopPrice + .0001, permission)
  const original = { price: first.initialStopPrice, modifiedAt: state.observedTimestamp }
  expect(tradeOverlayRecords(state.positions, state.closed).map(r => r.originalStop)).toEqual([original, null])
  state = observeCandle(state, { ...candle, timestamp: 300000 }, undefined, 'single')
  state = modifyStop(state, first.id, first.stopPrice + .0002, permission)
  state = modifyStop(state, first.id, first.initialStopPrice, permission)
  state = modifyStop(state, second.id, second.stopPrice + .0003, permission)
  expect(tradeOverlayRecords(state.positions, state.closed).map(r => r.originalStop)).toEqual([
    original, { price: second.initialStopPrice, modifiedAt: 300000 },
  ])
  expect(state.positions[0].stopModifications).toHaveLength(3)
})

it.each(TIMEFRAMES)('retains actual intrabar execution time on %s without inserting chart slots', timeframe => {
  const step = TIMEFRAME_MS[timeframe], candles = bars([0, step / 1000, 3 * step / 1000])
  expect(executionLogical(step * 1.75, candles, timeframe)).toBeCloseTo(1.75)
  expect(executionLogical(step * 3.25, candles, timeframe)).toBeCloseTo(2.25)
  expect(executionLogical(-1, candles, timeframe)).toBeNull()
  expect(executionLogical(step * 2.5, candles, timeframe)).toBeNull()
  expect(executionLogical(step, [], timeframe)).toBeNull()
})

it('draws exact-price executions and one subtle original SL after the first revealed modification with independent toggles', () => {
  const state = fixture(), closed = observeCandle(requestClose(state, state.positions[0].id, permission), { ...candle, timestamp: 300000 }, undefined, 'single')
  let records = tradeOverlayRecords(closed.positions, closed.closed)
  const primitive = new TradeOverlays()
  const context = Object.fromEntries(['save', 'restore', 'beginPath', 'rect', 'clip', 'moveTo', 'lineTo', 'closePath', 'fill', 'stroke', 'setLineDash'].map(key => [key, vi.fn()]))
  let visibleRange: { from: UTCTimestamp; to: UTCTimestamp } | null = null
  const redraw = vi.fn(), priceToCoordinate = vi.fn(price => price * 100), timeToCoordinate = vi.fn(time => 100 + time / 300 * 20)
  primitive.attached({ chart: { timeScale: () => ({ getVisibleRange: () => visibleRange, timeToCoordinate, options: () => ({ barSpacing: 20 }) }) }, series: { priceToCoordinate }, requestUpdate: redraw } as unknown as SeriesAttachedParameter)
  const draw = (cutoff: number, executions: boolean, history: boolean) => {
    vi.clearAllMocks()
    primitive.update(records, bars([0, 300]), 'M5', cutoff, executions, history)
    primitive.paneViews()[0].renderer()!.draw({ useMediaCoordinateSpace: (callback: (scope: unknown) => void) => callback({ context, mediaSize: { width: 500, height: 500 } }) } as unknown as Parameters<IPrimitivePaneRenderer['draw']>[0])
  }
  draw(300000, false, false)
  expect(context.fill).not.toHaveBeenCalled(); expect(context.stroke).not.toHaveBeenCalled()
  draw(240000, true, false)
  expect(context.fill).toHaveBeenCalledTimes(2); expect(context.stroke).not.toHaveBeenCalled()
  expect(context.moveTo.mock.calls[0][0]).toBeCloseTo(108)
  expect(context.moveTo.mock.calls[0][1]).toBeCloseTo(106) // actual 120s / 300s, price 1.1
  draw(300000, true, false)
  expect(context.fill).toHaveBeenCalledTimes(3); expect(context.stroke).toHaveBeenCalledTimes(2)
  expect(context.setLineDash).toHaveBeenCalledWith([3, 4])
  records = tradeOverlayRecords(state.positions, state.closed)
  draw(119999, false, true)
  expect(context.stroke).not.toHaveBeenCalled()
  draw(179999, false, true)
  expect(context.stroke).not.toHaveBeenCalled()
  draw(180000, false, true)
  expect(context.stroke).toHaveBeenCalledTimes(1); expect(context.fill).not.toHaveBeenCalled()
  draw(239999, false, true)
  expect(context.stroke).toHaveBeenCalledTimes(1)
  draw(300000, false, true)
  expect(context.stroke).toHaveBeenCalledTimes(1)
  expect(priceToCoordinate).toHaveBeenCalledExactlyOnceWith(state.positions[0].initialStopPrice)
  expect(context.lineWidth).toBe(1)
  expect(primitive).not.toHaveProperty('autoscaleInfo')
  expect(primitive).not.toHaveProperty('hitTest')
  for (const [x] of context.moveTo.mock.calls) expect(x).toBe(0)
  for (const [x] of context.lineTo.mock.calls) expect(x).toBe(500)
  // Rays remain full-width when panning past their original time intervals,
  // without requiring either endpoint to exist in the current chart data.
  visibleRange = { from: 900 as UTCTimestamp, to: 1200 as UTCTimestamp }
  timeToCoordinate.mockImplementation(() => { throw new Error('Original SL must not resolve time coordinates') })
  draw(300000, false, true)
  expect(context.stroke).toHaveBeenCalledTimes(1)
  for (const [x] of context.moveTo.mock.calls) expect(x).toBe(0)
  for (const [x] of context.lineTo.mock.calls) expect(x).toBe(500)
  records = tradeOverlayRecords(closed.positions, closed.closed)
  draw(240000, false, true) // Review never resurrects currently closed references.
  expect(context.stroke).not.toHaveBeenCalled()
  draw(300000, false, true)
  expect(context.stroke).not.toHaveBeenCalled()
  expect(context.setLineDash).toHaveBeenCalledWith([4, 4])
  expect(context.strokeStyle).toBe('rgba(239, 154, 154, 0.28)')
  primitive.detached()
  expect(redraw).toHaveBeenCalledTimes(1)
})

it.each(['manual', 'stop_loss'] as const)('removes only the closed position’s original SL on %s execution across all panes and restores', reason => {
  let state = fixture()
  const [first, second] = state.positions
  state = modifyStop(state, second.id, 1.0895, permission)
  const history = state.positions.map(p => ({ id: p.id, initialStopPrice: p.initialStopPrice, stopModifications: structuredClone(p.stopModifications) }))
  const contexts = Array.from({ length: 4 }, () => Object.fromEntries(['save', 'restore', 'beginPath', 'rect', 'clip', 'moveTo', 'lineTo', 'closePath', 'fill', 'stroke', 'setLineDash'].map(key => [key, vi.fn()])))
  const panes = contexts.map(() => {
    const primitive = new TradeOverlays()
    primitive.attached({ chart: { timeScale: () => ({ getVisibleRange: () => null, timeToCoordinate: () => 100, options: () => ({ barSpacing: 20 }) }) },
      series: { priceToCoordinate: (price: number) => price * 100 }, requestUpdate: vi.fn() } as unknown as SeriesAttachedParameter)
    return primitive
  })
  const check = (expectedPrices: number[], cutoff = state.observedTimestamp!) => {
    const before = JSON.stringify(state)
    // Session restoration must produce the same visibility from durable records.
    const restored = JSON.parse(before)
    for (let i = 0; i < panes.length; i++) {
      const context = contexts[i]; context.stroke.mockClear(); context.moveTo.mockClear()
      panes[i].update(tradeOverlayRecords(restored.positions, restored.closed), bars([0, 300]), ['H1', 'D1', 'M5', 'H4'][i] as typeof TIMEFRAMES[number], cutoff, false, true)
      panes[i].paneViews()[0].renderer()!.draw({ useMediaCoordinateSpace: (callback: (scope: unknown) => void) => callback({ context, mediaSize: { width: 500, height: 500 } }) } as unknown as Parameters<IPrimitivePaneRenderer['draw']>[0])
      expect(context.stroke).toHaveBeenCalledTimes(expectedPrices.length)
      expect(context.moveTo.mock.calls).toEqual(expectedPrices.map(price => [0, price * 100]))
    }
    expect(JSON.stringify(state)).toBe(before)
    for (const saved of history) {
      const position = [...state.positions, ...state.closed].find(p => p.id === saved.id)!
      expect(position.initialStopPrice).toBe(saved.initialStopPrice)
      expect(position.stopModifications).toEqual(saved.stopModifications)
    }
  }
  check([], 179999)
  check([first.initialStopPrice], 180000)
  check([first.initialStopPrice], 239999)
  check([first.initialStopPrice, second.initialStopPrice])
  if (reason === 'manual') {
    state = requestClose(state, first.id, permission)
    expect(state.positions[0].closeRequestedAt).not.toBeNull()
    check([first.initialStopPrice, second.initialStopPrice])
  }
  state = observeCandle(state, { ...candle, timestamp: 300000, low: reason === 'stop_loss' ? 1.0901 : candle.low }, undefined, 'single')
  expect(state.closed[0].id).toBe(first.id)
  expect(state.closed[0].exitReason).toBe(reason)
  expect(state.positions.map(p => p.id)).toEqual([second.id])
  check([second.initialStopPrice])
  state = observeCandle(state, { ...candle, timestamp: 360000 }, undefined, 'single')
  check([second.initialStopPrice])
  state = requestClose(state, second.id, permission)
  check([second.initialStopPrice])
  state = observeCandle(state, { ...candle, timestamp: 420000 }, undefined, 'single')
  expect(state.positions).toHaveLength(0)
  check([])
  for (const pane of panes) pane.detached()
})
