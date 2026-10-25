// @vitest-environment jsdom
import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import { DraftStopAnnotation, draftDistanceLabel, useDraftStopAnnotation } from './DraftStopAnnotation'
import { draftEstimate, draftObservedPrice, type StopDraft } from './TradingDock'
import { createTradingState, observeCandle, requestAutomaticEntry } from './trading'

const candle = { timestamp: 60000, open: 1.1, high: 1.101, low: 1.099, close: 1.1 }
const permission = { active: true, playing: false, hasFuture: true }
const draft = (direction: StopDraft['direction'] = 'buy'): StopDraft => ({ direction, sizing: .01, setupId: null, slot: 1, price: 1.099 })
it('formats absolute pip distance to one decimal and names invalid sides and missing prices', () => {
 expect(draftDistanceLabel(1.09857, 1.1, 'buy')).toBe('Draft SL · 14.3 pips')
 expect(draftDistanceLabel(1.10143, 1.1, 'sell')).toBe('Draft SL · 14.3 pips')
 expect(draftDistanceLabel(1.10143, 1.1, 'buy')).toContain('Invalid SL side')
 expect(draftDistanceLabel(1.1, 1.1, 'sell')).toContain('Invalid SL side')
 for (const reference of [null, NaN, Infinity, 0]) expect(draftDistanceLabel(1.1, reference, 'buy')).toBe('Draft SL · Distance unavailable')
})
it('uses only observed 6E trades, legacy entry ask/bid, and legacy modification bid/ask', () => {
 const legacy = observeCandle(createTradingState(), candle, { ...candle, close: 1.1002 })
 expect(draftObservedPrice(legacy, draft('buy'))).toBe(1.1002)
 expect(draftObservedPrice(legacy, draft('sell'))).toBe(1.1)
 expect(draftObservedPrice(legacy, { ...draft('buy'), positionId: 'existing' })).toBe(1.1)
 expect(draftObservedPrice(legacy, { ...draft('sell'), positionId: 'existing' })).toBe(1.1002)
 const single = observeCandle({ ...createTradingState(), symbol: '6E' }, candle, undefined, 'single')
 for (const direction of ['buy', 'sell'] as const) {
  expect(draftObservedPrice(single, draft(direction))).toBe(1.1)
  expect(draftObservedPrice(single, { ...draft(direction), positionId: 'existing' })).toBe(1.1)
 }
 expect(draftObservedPrice({ ...single, quote: { priceModel: 'single', trade: null } }, draft())).toBeNull()
 expect(draftObservedPrice({ ...legacy, quote: { bid: candle, ask: null } }, draft())).toBeNull()
 expect(draftEstimate({ ...single, quote: null }, draft()).error).toContain('unavailable')
 expect(draftEstimate(single, { ...draft(), price: 1.101 }).error).toContain('below')
 expect(draftEstimate(single, { ...draft('sell'), price: 1.099 }).error).toContain('above')
})
it('keeps modification risk relative to entry while draft distance uses the current market', () => {
 let state = observeCandle({ ...createTradingState(), symbol: '6E' }, candle, undefined, 'single')
 state = requestAutomaticEntry(state, 'buy', .01, 1.095, permission)
 state = observeCandle(state, { ...candle, timestamp: 120000 }, undefined, 'single')
 state = observeCandle(state, { ...candle, timestamp: 180000, close: 1.102, high: 1.103 }, undefined, 'single')
 const modification = { ...draft(), positionId: state.positions[0].id, price: 1.099 }
 expect(draftEstimate(state, modification).risk).toBeCloseTo(1)
 expect(draftDistanceLabel(modification.price, draftObservedPrice(state, modification), 'buy')).toBe('Draft SL · 30.0 pips')
})

let host: HTMLDivElement, root: ReturnType<typeof createRoot>, placement: StopDraft, picks: ReturnType<typeof vi.fn<(price: number) => void>>, confirms: ReturnType<typeof vi.fn<() => void>>
let move: (e: any) => void, click: (e: any) => void, options: any, renders: number
const series = { coordinateToPrice: (y: number) => 1.11 - y / 10000, priceToCoordinate: (p: number) => (1.11 - p) * 10000,
 createPriceLine: vi.fn((next: any) => { options = next; return { applyOptions: (next: any) => { options = next } } }), removePriceLine: vi.fn(), attachPrimitive: vi.fn(), detachPrimitive: vi.fn() } as unknown as ISeriesApi<'Candlestick'>
const chart = { timeScale: () => ({ width: () => 400 }), panes: () => [{ getHeight: () => 300 }], applyOptions: vi.fn(),
 subscribeCrosshairMove: (fn: typeof move) => { move = fn }, unsubscribeCrosshairMove: vi.fn(), subscribeClick: (fn: typeof click) => { click = fn }, unsubscribeClick: vi.fn() } as unknown as IChartApi
function Harness() {
 renders++
 const annotation = useRef<HTMLDivElement>(null), container = useRef<HTMLDivElement>(null), chartRef = useRef(chart), seriesRef = useRef(series)
 useDraftStopAnnotation(annotation, container, chartRef, seriesRef, placement, 1.1, picks)
 return <div data-plot><div ref={container}/><DraftStopAnnotation element={annotation} selected={placement.price !== null} onConfirm={confirms}/></div>
}
function pointer(type: string, y: number) {
 const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 80, clientY: y, button: 0 })
 Object.defineProperty(event, 'pointerId', { value: 1 }); host.querySelector('[data-plot]')!.dispatchEvent(event)
}
beforeEach(async () => {
 Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); placement = draft(); picks = vi.fn(); confirms = vi.fn(); renders = 0
 Object.assign(HTMLElement.prototype, { setPointerCapture: vi.fn(), hasPointerCapture: () => false, releasePointerCapture: vi.fn() })
 host = document.createElement('div'); document.body.append(host); root = createRoot(host)
 await act(async () => root.render(<Harness/>))
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllMocks() })
it.each(['buy', 'sell'] as const)('updates %s hover distance without React renders, preserves axis prices and selects only on click', async direction => {
 placement = { ...draft(direction), price: null }; await act(async () => root.render(<Harness/>)); const before = renders
 move({ sourceEvent: {}, point: { x: 80, y: direction === 'buy' ? 120 : 80 }, paneIndex: 0 })
 const node = host.querySelector<HTMLDivElement>('.draft-stop-annotation')!
 expect(node.hidden).toBe(false); expect(node.textContent).toContain('20.0 pips'); expect(node.textContent).not.toContain('Invalid')
 move({ sourceEvent: {}, point: { x: 80, y: direction === 'buy' ? 130 : 70 }, paneIndex: 0 })
 expect(node.textContent).toContain('30.0 pips'); expect(renders).toBe(before); expect(picks).not.toHaveBeenCalled()
 expect(options).toMatchObject({ axisLabelVisible: true, title: '' })
 expect(node.querySelector('button')!.hidden).toBe(true)
 click({ point: { x: 80, y: 130 }, paneIndex: 0 }); expect(picks).toHaveBeenCalledTimes(1); expect(confirms).not.toHaveBeenCalled()
})
it('drags selected drafts as previews, commits only the selection on release and never confirms', async () => {
 pointer('pointerdown', 110); pointer('pointermove', 130)
 expect(host.textContent).toContain('30.0 pips'); expect(picks).not.toHaveBeenCalled(); expect(confirms).not.toHaveBeenCalled()
 pointer('pointerup', 130); pointer('pointerup', 130)
 expect(picks).toHaveBeenCalledExactlyOnceWith(1.097); expect(confirms).not.toHaveBeenCalled()
})
it.each(['pointercancel', 'lostpointercapture', 'blur', 'Escape'])('restores the selected price on %s without confirmation', reason => {
 pointer('pointerdown', 110); pointer('pointermove', 130)
 if (reason === 'Escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
 else if (reason === 'blur') window.dispatchEvent(new Event('blur'))
 else host.querySelector('[data-plot]')!.dispatchEvent(new Event(reason))
 pointer('pointerup', 130)
 expect(host.textContent).toContain('10.0 pips'); expect(picks).not.toHaveBeenCalled(); expect(confirms).not.toHaveBeenCalled()
})
it('shows invalid side during movement and ignores the axis and indicator panes', async () => {
 placement = { ...draft(), price: null }; await act(async () => root.render(<Harness/>))
 move({ sourceEvent: {}, point: { x: 80, y: 80 }, paneIndex: 0 }); expect(host.textContent).toContain('Invalid SL side')
 const before = host.textContent
 move({ sourceEvent: {}, point: { x: 410, y: 130 }, paneIndex: 0 }); move({ sourceEvent: {}, point: { x: 80, y: 130 }, paneIndex: 1 })
 expect(host.textContent).toBe(before)
})
