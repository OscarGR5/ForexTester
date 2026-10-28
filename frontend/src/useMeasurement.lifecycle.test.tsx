// @vitest-environment jsdom
import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi, type MockInstance } from 'vitest'
import type { IChartApi, ISeriesApi, SeriesAttachedParameter, UTCTimestamp } from 'lightweight-charts'
import { useMeasurement } from './useMeasurement'
import { MeasurementPrimitive } from './MeasurementPrimitive'

const applyOptions = vi.fn(), attach = vi.fn(), detach = vi.fn()
const chart = { timeScale: () => ({ width: () => 400, coordinateToLogical: (x: number) => x/10, timeToIndex: (time: number) => time/60 }),
 panes: () => [{ getHeight: () => 300 }], options: () => ({ handleScroll: { pressedMouseMove: true }, handleScale: { axisPressedMouseMove: { price: true, time: true } } }), applyOptions } as unknown as IChartApi
const series = { coordinateToPrice: (y: number) => 1.2-y/10000, attachPrimitive: attach, detachPrimitive: detach } as unknown as ISeriesApi<'Candlestick'>
let host: HTMLDivElement, root: ReturnType<typeof createRoot>, resetKey: string, blocked: boolean, captured: Set<number>, data: { time: UTCTimestamp }[]
let clear: MockInstance<MeasurementPrimitive['setData']>
function Harness() {
 const container=useRef<HTMLDivElement>(null), chartRef=useRef(chart), seriesRef=useRef(series)
 useMeasurement(container,chartRef,seriesRef,()=>data,blocked,resetKey,.0001,()=>false)
 return <div ref={container} data-chart/>
}
const render=()=>act(async()=>root.render(<Harness/>))
const pointer=(type:string,x=100,y=100,shiftKey=false)=>{
 const event=new MouseEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:y,shiftKey,button:0})
 Object.defineProperty(event,'pointerId',{value:1}); host.firstElementChild!.dispatchEvent(event)
}
beforeEach(async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true}); captured=new Set(); resetKey='session-1:H1:1'; blocked=false
 data=Array.from({length:30},(_,i)=>({time:i*60 as UTCTimestamp}))
 applyOptions.mockClear(); attach.mockClear(); detach.mockClear()
 attach.mockImplementation((primitive:MeasurementPrimitive)=>primitive.attached({chart,series,requestUpdate(){}} as unknown as SeriesAttachedParameter))
 detach.mockImplementation((primitive:MeasurementPrimitive)=>primitive.detached())
 clear=vi.spyOn(MeasurementPrimitive.prototype,'setData')
 Object.assign(HTMLElement.prototype,{setPointerCapture:(id:number)=>captured.add(id),hasPointerCapture:(id:number)=>captured.has(id),releasePointerCapture:(id:number)=>captured.delete(id)})
 host=document.createElement('div'); document.body.append(host); root=createRoot(host); await render()
})
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks()})
it.each(['session-2:H1:1','session-1:M5:1','session-1:H1:3'])('clears and releases capture on lifecycle change %s',async next=>{
 pointer('pointerdown',100,100,true); pointer('pointermove',200,50)
 expect(captured.size).toBe(1)
 resetKey=next; await render()
 expect(captured.size).toBe(0); expect(clear).toHaveBeenLastCalledWith(null)
 expect(detach).toHaveBeenCalledExactlyOnceWith(attach.mock.calls[0][0]); expect(attach).toHaveBeenCalledTimes(2)
 expect(applyOptions).toHaveBeenLastCalledWith({handleScroll:{pressedMouseMove:true},handleScale:{axisPressedMouseMove:{price:true,time:true}}})
})
it('clears completed measurements on placement and on replay rewind',async()=>{
 pointer('pointerdown',100,100,true); pointer('pointermove',200,50); pointer('pointerup',200,50)
 blocked=true; await render(); expect(clear).toHaveBeenLastCalledWith(null)
 blocked=false; await render(); pointer('pointerdown',100,100,true); pointer('pointermove',200,50); pointer('pointerup',200,50)
 data=data.slice(0,15); await render(); expect(clear).toHaveBeenLastCalledWith(null)
})
it('unmounts an active gesture, detaches its primitive and removes event handlers',async()=>{
 pointer('pointerdown',100,100,true); pointer('pointerup'); expect(captured.size).toBe(0)
 await act(async()=>root.unmount()); expect(detach).toHaveBeenCalledExactlyOnceWith(attach.mock.calls[0][0]); expect(clear).toHaveBeenLastCalledWith(null)
 applyOptions.mockClear(); window.dispatchEvent(new Event('blur')); window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))
 expect(applyOptions).not.toHaveBeenCalled()
})
