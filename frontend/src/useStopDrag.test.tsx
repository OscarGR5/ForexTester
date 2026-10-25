// @vitest-environment jsdom
import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { IChartApi, ISeriesApi, SeriesAttachedParameter } from 'lightweight-charts'
import { useStopDrag, type StopInteraction } from './useStopDrag'
import { StopLabels } from './stopLabels'
import { stopOverlays } from './stopOverlays'
import { ChartSynchronizer } from './chartSync'
import { createTradingState, observeCandle, requestAutomaticEntry, modifyStop } from './trading'
const permission = { active: true, playing: false, hasFuture: true }
const candle = { timestamp: 60000, open: 1.1, high: 1.11, low: 1.09, close: 1.1 }
function state() {
 let s = observeCandle({ ...createTradingState(), symbol: '6E' }, candle, undefined, 'single')
 s = requestAutomaticEntry(s, 'buy', .01, 1.05, permission); s = requestAutomaticEntry(s, 'buy', .01, 1.05, permission)
 return observeCandle(s, { ...candle, timestamp: 120000 }, undefined, 'single')
}
let host: HTMLDivElement, root: ReturnType<typeof createRoot>, s: ReturnType<typeof state>, labels: StopLabels
let enabled: boolean, placing: boolean, preview: ReturnType<typeof vi.fn<StopInteraction['onPreview']>>, commit: ReturnType<typeof vi.fn<StopInteraction['onCommit']>>, pan: ReturnType<typeof vi.fn<() => void>>, sync: ChartSynchronizer
const chart = { timeScale: () => ({ width: () => 400 }), panes: () => [{ getHeight: () => 300 }] } as unknown as IChartApi
const series = { coordinateToPrice: (y: number) => 1.2 - y / 1000, priceToCoordinate: (p: number) => (1.2 - p) * 1000 } as unknown as ISeriesApi<'Candlestick'>
// Exercise the primitive's rendered rectangles, including displaced labels.
function renderLabels() {
 labels.setData(stopOverlays(s))
 const context = { save() {}, restore() {}, measureText: () => ({ width: 200 }), beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fillRect() {}, fillText() {} }
 labels.paneViews()[0].renderer()!.draw({ useMediaCoordinateSpace: (draw: any) => draw({ context, mediaSize: { width: 400, height: 300 } }) } as any)
}
function Harness() {
 const container = useRef<HTMLDivElement>(null), chartRef = useRef(chart), seriesRef = useRef(series), labelRef = useRef({ hitTest: (x: number, y: number) => labels.hitAnnotation(x, y) })
 const interaction: StopInteraction = { enabled, preview: null, onPreview: preview, onCommit: commit }
 useStopDrag(container, chartRef, seriesRef, labelRef, s.positions, sync, interaction, placing)
 return <div ref={container} data-chart onPointerDown={() => pan()}/>
}
function pointer(type: string, y: number, x = 100, pointerId = 1) {
 const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })
 Object.defineProperty(event, 'pointerId', { value: pointerId }); surface().dispatchEvent(event)
}
const rerender = () => act(async () => { renderLabels(); root.render(<Harness/>) })
beforeEach(async () => {
 Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); s = state(); enabled = true; placing = false
 labels = new StopLabels(); labels.attached({ series, requestUpdate() {} } as unknown as SeriesAttachedParameter); renderLabels()
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
it.each([0, 1])('drags nearby line %s by closest Y and locks its ID while crossing the other line', async index => {
 s.positions[1] = { ...s.positions[1], stopPrice: 1.046 }; await rerender()
 const before = structuredClone(s), y = index ? 154 : 150
 await act(async () => { pointer('pointerdown', y); pointer('pointermove', 145) })
 expect(preview).toHaveBeenLastCalledWith({ id: s.positions[index].id, price: 1.055 })
 expect(s).toEqual(before); expect(pan).not.toHaveBeenCalled(); expect(host.querySelectorAll('button')).toHaveLength(0)
 await act(async () => pointer('pointerup', 145))
 expect(commit).toHaveBeenCalledExactlyOnceWith(before.positions[index].id, 1.055)
 expect(s.positions[1-index]).toEqual(before.positions[1-index]); expect(s.positions[index].stopModifications).toHaveLength(1)
 expect(preview).toHaveBeenLastCalledWith(null); expect(sync.suspendCrosshair).toHaveBeenLastCalledWith(false)
})
it.each([0, 1])('targets rendered coincident annotation %s and preserves the pointer offset', async index => {
 const before = structuredClone(s), y = index ? 175 : 150
 expect(labels.hitAnnotation(300, y)).toBe(s.positions[index].id)
 await act(async () => { pointer('pointerdown', y, 300); pointer('pointermove', y - 20, 300) })
 expect(preview).toHaveBeenLastCalledWith({ id: s.positions[index].id, price: 1.07 })
 expect(s).toEqual(before)
 await act(async () => pointer('pointerup', y - 20, 300))
 expect(commit).toHaveBeenCalledExactlyOnceWith(before.positions[index].id, 1.07)
 expect(s.positions[1-index]).toEqual(before.positions[1-index]); expect(s.positions[index].stopPrice).toBe(1.07)
})
it('does not choose an arbitrary ID on an indistinguishable shared line', async () => {
 await act(async () => { pointer('pointerdown', 150); pointer('pointermove', 130); pointer('pointerup', 130) })
 expect(commit).not.toHaveBeenCalled(); expect(pan).toHaveBeenCalledTimes(1)
})
it('prioritizes a displaced annotation over the closer actual line', async () => {
 s.positions[1] = { ...s.positions[1], stopPrice: 1.046 }; await rerender()
 // SL 1 bounds cover a point closer to the actual SL 2 line.
 await act(async () => { pointer('pointerdown', 156, 300); pointer('pointermove', 136, 300); pointer('pointerup', 136, 300) })
 expect(commit).toHaveBeenCalledExactlyOnceWith(s.positions[0].id, 1.07)
})
it('keeps an invalid release at the previous confirmed stop and preserves the other position', async () => {
 const before = structuredClone(s)
 await act(async () => { pointer('pointerdown', 175, 300); pointer('pointermove', 75, 300); pointer('pointerup', 75, 300) })
 expect(commit).toHaveBeenCalledExactlyOnceWith(s.positions[1].id, 1.15); expect(s).toEqual(before)
})
it.each(['Escape', 'pointercancel', 'lostpointercapture', 'blur'])('cancels %s without a modification', async reason => {
 await act(async () => { pointer('pointerdown', 175, 300); pointer('pointermove', 155, 300) })
 await act(async () => {
  if (reason === 'Escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  else if (reason === 'blur') window.dispatchEvent(new Event('blur'))
  else surface().dispatchEvent(new Event(reason))
  pointer('pointerup', 155, 300)
 })
 expect(commit).not.toHaveBeenCalled(); expect(s.positions.every(p => p.stopPrice === 1.05)).toBe(true)
 expect(sync.suspendCrosshair).toHaveBeenLastCalledWith(false)
})
it.each(['permission', 'placement'])('cancels on %s changes and leaves outside navigation alone', async reason => {
 await act(async () => pointer('pointerdown', 210)); expect(pan).toHaveBeenCalledTimes(1)
 await act(async () => pointer('pointerdown', 175, 300))
 if (reason === 'permission') enabled = false; else placing = true
 await rerender(); await act(async () => { pointer('pointerup', 155, 300); pointer('pointerdown', 175, 300) })
 expect(commit).not.toHaveBeenCalled()
})
it('ignores another pointer during a captured drag', async () => {
 await act(async () => { pointer('pointerdown', 175, 300); pointer('pointerdown', 150, 300, 2); pointer('pointermove', 130, 300, 2); pointer('pointerup', 130, 300, 2) })
 expect(commit).not.toHaveBeenCalled()
 await act(async () => { pointer('pointermove', 155, 300); pointer('pointerup', 155, 300) })
 expect(commit).toHaveBeenCalledExactlyOnceWith(s.positions[1].id, 1.07)
})
it('does not target an open line through a pending annotation', async () => {
 const hit = vi.spyOn(labels, 'hitAnnotation').mockReturnValue('pending')
 await act(async () => { pointer('pointerdown', 150, 300); pointer('pointerup', 150, 300) })
 expect(hit).toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled()
})
