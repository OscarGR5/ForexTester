// @vitest-environment jsdom
import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import { useStopDrag, type StopInteraction } from './useStopDrag'
import { ChartSynchronizer } from './chartSync'
import { createTradingState, observeCandle, requestAutomaticEntry, modifyStop } from './trading'
const permission = { active: true, playing: false, hasFuture: true }
const candle = { timestamp: 60000, open: 1.1, high: 1.11, low: 1.09, close: 1.1 }
function state() {
 let s = observeCandle({ ...createTradingState(), symbol: '6E' }, candle, undefined, 'single')
 s = requestAutomaticEntry(s, 'buy', .01, 1.05, permission); s = requestAutomaticEntry(s, 'buy', .01, 1.05, permission)
 return observeCandle(s, { ...candle, timestamp: 120000 }, undefined, 'single')
}
let host: HTMLDivElement, root: ReturnType<typeof createRoot>, s: ReturnType<typeof state>
let enabled: boolean, preview: ReturnType<typeof vi.fn<StopInteraction['onPreview']>>, commit: ReturnType<typeof vi.fn<StopInteraction['onCommit']>>, pan: ReturnType<typeof vi.fn<() => void>>, sync: ChartSynchronizer
const chart = { timeScale: () => ({ width: () => 400 }), panes: () => [{ getHeight: () => 300 }] } as unknown as IChartApi
const series = { coordinateToPrice: (y: number) => 1.2 - y / 1000, priceToCoordinate: (p: number) => (1.2 - p) * 1000 } as unknown as ISeriesApi<'Candlestick'>
function Harness() {
 const container = useRef<HTMLDivElement>(null), chartRef = useRef(chart), seriesRef = useRef(series)
 const interaction: StopInteraction = { enabled, preview: null, onPreview: preview, onCommit: commit }
 const drag = useStopDrag(container, chartRef, seriesRef, s.positions, sync, interaction)
 return <><div ref={container} data-chart onPointerDown={() => pan()}/>{drag.choices.map(p => <button key={p.id} onPointerDown={event => drag.begin(p.id, event.nativeEvent)}>{p.id}</button>)}</>
}
function pointer(target: Element, type: string, y: number) {
 const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 100, clientY: y, button: 0 })
 Object.defineProperty(event, 'pointerId', { value: 1 }); target.dispatchEvent(event)
}
beforeEach(async () => {
 Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); s = state(); enabled = true
 preview = vi.fn<StopInteraction['onPreview']>(); pan = vi.fn<() => void>(); sync = new ChartSynchronizer(); vi.spyOn(sync, 'suspendCrosshair')
 commit = vi.fn((id: string, price: number) => { s = modifyStop(s, id, price, permission); return null })
 let captured = false
 vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 0, left: 0, width: 400, height: 300 } as DOMRect)
 Object.assign(HTMLElement.prototype, { setPointerCapture: () => { captured = true }, releasePointerCapture: () => { captured = false }, hasPointerCapture: () => captured })
 host = document.createElement('div'); document.body.append(host); root = createRoot(host)
 await act(async () => root.render(<Harness/>))
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks() })
const surface = () => host.querySelector('[data-chart]')!
const choose = async () => {
 await act(async () => pointer(surface(), 'pointerdown', 150))
 const buttons = host.querySelectorAll('button'); expect(buttons.length).toBe(2)
 await act(async () => pointer(buttons[1], 'pointerdown', 150))
}
it('selects overlapping position IDs, previews without saving, consumes the drag and commits once on release', async () => {
 await choose(); await act(async () => pointer(surface(), 'pointermove', 130))
 expect(preview).toHaveBeenLastCalledWith({ id: s.positions[1].id, price: 1.07 })
 expect(s.positions[1].stopPrice).toBe(1.05); expect(commit).not.toHaveBeenCalled(); expect(pan).not.toHaveBeenCalled()
 await act(async () => pointer(surface(), 'pointerup', 130))
 expect(commit).toHaveBeenCalledTimes(1); expect(s.positions[0].stopPrice).toBe(1.05)
 expect(s.positions[1].stopPrice).toBe(1.07); expect(s.positions[1].stopModifications).toHaveLength(1)
 expect(preview).toHaveBeenLastCalledWith(null); expect(sync.suspendCrosshair).toHaveBeenLastCalledWith(false)
})
it.each(['Escape', 'pointercancel', 'lostpointercapture', 'blur'])('cancels %s and restores synchronization without a modification', async reason => {
 await choose(); await act(async () => pointer(surface(), 'pointermove', 130))
 await act(async () => {
  if (reason === 'Escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  else if (reason === 'blur') window.dispatchEvent(new Event('blur'))
  else surface().dispatchEvent(new Event(reason))
  pointer(surface(), 'pointerup', 130)
 })
 expect(commit).not.toHaveBeenCalled(); expect(s.positions.every(p => p.stopPrice === 1.05)).toBe(true)
 expect(sync.suspendCrosshair).toHaveBeenLastCalledWith(false)
})
it('leaves navigation alone outside the hit target and blocks drag when replay permission changes', async () => {
 await act(async () => pointer(surface(), 'pointerdown', 180)); expect(pan).toHaveBeenCalledTimes(1); expect(host.querySelectorAll('button')).toHaveLength(0)
 await choose(); enabled = false; await act(async () => root.render(<Harness/>))
 await act(async () => pointer(surface(), 'pointerup', 130)); expect(commit).not.toHaveBeenCalled()
 await act(async () => pointer(surface(), 'pointerdown', 150)); expect(host.querySelectorAll('button')).toHaveLength(0)
})
