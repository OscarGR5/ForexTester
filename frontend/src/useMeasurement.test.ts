// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts'
import { bindMeasurement } from './useMeasurement'
import type { Measurement } from './measurement'
let element: HTMLDivElement, controller: ReturnType<typeof bindMeasurement>, captured: Set<number>, value: Measurement | null
let blocked = false, data: { time: UTCTimestamp }[], pan: ReturnType<typeof vi.fn<() => void>>, tradingClick: ReturnType<typeof vi.fn<() => void>>
const applyOptions = vi.fn(), originalScroll = { pressedMouseMove: true }, originalScale = { mouseWheel: false, pinch: true }
const chart = { timeScale: () => ({ width: () => 400, coordinateToLogical: (x: number) => x/10, timeToIndex: (time: number) => (time-1000)/60 }),
 panes: () => [{ getHeight: () => 300 }], options: () => ({ handleScroll: originalScroll, handleScale: originalScale }), applyOptions } as unknown as IChartApi
const series = { coordinateToPrice: (y: number) => 1.2-y/10000 } as unknown as ISeriesApi<'Candlestick'>
function pointer(type: string, x = 100, y = 100, shiftKey = false, target: EventTarget = element, pointerId = 1) {
 const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, shiftKey })
 Object.defineProperty(e,'pointerId',{value:pointerId}); target.dispatchEvent(e)
 return e
}
beforeEach(() => {
 blocked = false; value = null; applyOptions.mockClear(); captured = new Set()
 data = Array.from({length:30},(_,i)=>({ time: (1000+i*60) as UTCTimestamp }))
 element = document.createElement('div'); document.body.append(element)
 element.setPointerCapture = id => { captured.add(id) }; element.hasPointerCapture = id => captured.has(id)
 element.releasePointerCapture = id => { captured.delete(id); element.dispatchEvent(new Event('lostpointercapture')) }
 controller = bindMeasurement({element,chart,series,candles:()=>data,blocked:()=>blocked,setData:v=>{ value=v }})
 pan = vi.fn(); tradingClick = vi.fn(); element.addEventListener('pointerdown',pan); element.addEventListener('click',tradingClick)
})
afterEach(() => { controller.dispose(); element.remove() })
it('drags without native pan or trading clicks, restores exact interactions, and clears on ordinary click', () => {
 pointer('pointerdown',100,100,true); pointer('pointermove',200,50); pointer('pointerup',200,50)
 element.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))
 expect(pan).not.toHaveBeenCalled(); expect(tradingClick).not.toHaveBeenCalled(); expect(captured.size).toBe(0)
 expect(value!.start.index).toBe(10); expect(value!.end.index).toBe(20); expect(value!.end.price).toBe(1.195)
 expect(applyOptions).toHaveBeenLastCalledWith({handleScroll:originalScroll,handleScale:originalScale})
 pointer('pointerdown'); expect(value).toBeNull(); expect(pan).toHaveBeenCalledOnce()
})
it('supports click, free movement across chart boundaries, click to finish', () => {
 pointer('pointerdown',100,100,true); pointer('pointerup'); expect(captured.size).toBe(0)
 pointer('pointermove',800,-20,false,document.body); expect(value!.end.index).toBe(29); expect(value!.end.price).toBe(1.2)
 pointer('pointerdown',200,200); pointer('pointerup',200,200)
 expect(value!.end.index).toBe(20); expect(captured.size).toBe(0)
 pointer('pointermove',300,100); expect(value!.end.index).toBe(20)
})
it.each(['another chart','order control','chart toolbar','price axis','indicator pane'])('cancels an awaiting measurement without consuming a click on %s', targetName => {
 const pane=document.createElement('section'); pane.className='chart-pane'; document.body.append(pane); pane.append(element)
 const external=document.createElement(targetName==='order control' || targetName==='chart toolbar' ? 'button' : 'div')
 external.textContent=targetName==='order control' ? 'Buy' : targetName
 if(targetName==='chart toolbar') pane.append(external); else document.body.append(external)
 const target=targetName==='price axis' || targetName==='indicator pane' ? element : external
 const x=targetName==='price axis' ? 410 : 100, y=targetName==='indicator pane' ? 310 : 100
 const handler=vi.fn<(event: Event) => void>()
 for(const type of ['pointerdown','mousedown','pointerup','mouseup','click']) target.addEventListener(type,handler)
 try {
  pointer('pointerdown',100,100,true); pointer('pointerup'); pointer('pointermove',200,50)
  expect(value).not.toBeNull(); expect(captured.size).toBe(0)
  const down=pointer('pointerdown',x,y,false,target)
  expect(down.defaultPrevented).toBe(false); expect(value).toBeNull()
  expect(applyOptions).toHaveBeenLastCalledWith({handleScroll:originalScroll,handleScale:originalScale})
  const mouseDown=new MouseEvent('mousedown',{bubbles:true,cancelable:true}); target.dispatchEvent(mouseDown)
  const up=pointer('pointerup',x,y,false,target)
  const mouseUp=new MouseEvent('mouseup',{bubbles:true,cancelable:true}); target.dispatchEvent(mouseUp)
  const click=new MouseEvent('click',{bubbles:true,cancelable:true}); target.dispatchEvent(click)
  for(const event of [mouseDown,up,mouseUp,click]) expect(event.defaultPrevented).toBe(false)
  expect(handler.mock.calls.map(([event])=>event.type)).toEqual(['pointerdown','mousedown','pointerup','mouseup','click'])
  expect(captured.size).toBe(0); expect(element.style.cursor).toBe('')
  pointer('pointermove',300,100); expect(value).toBeNull()
 } finally {
  for(const type of ['pointerdown','mousedown','pointerup','mouseup','click']) target.removeEventListener(type,handler)
  document.body.append(element); pane.remove(); external.remove()
 }
})
it('lets a Shift click start a measurement in another chart while cancelling the awaiting ruler', () => {
 const other=document.createElement('div'); document.body.append(other)
 other.setPointerCapture=element.setPointerCapture; other.hasPointerCapture=element.hasPointerCapture; other.releasePointerCapture=element.releasePointerCapture
 let otherValue:Measurement|null=null
 const otherController=bindMeasurement({element:other,chart,series,candles:()=>data,blocked:()=>false,setData:v=>{otherValue=v}})
 try {
  pointer('pointerdown',100,100,true); pointer('pointerup')
  pointer('pointerdown',100,100,true,other)
  expect(value).toBeNull(); expect(otherValue).not.toBeNull()
  pointer('pointermove',200,50,false,other); pointer('pointerup',200,50,false,other)
  expect(otherValue).toMatchObject({start:{index:10},end:{index:20}}); expect(captured.size).toBe(0)
 } finally { otherController.dispose(); other.remove() }
})
it.each(['Escape','pointercancel','lostpointercapture','blur','dispose'])('cancels and releases on %s', reason => {
 pointer('pointerdown',100,100,true); pointer('pointermove',200,50)
 if(reason==='Escape') window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))
 else if(reason==='blur') window.dispatchEvent(new Event('blur'))
 else if(reason==='dispose') controller.dispose()
 else element.dispatchEvent(new Event(reason,{bubbles:true}))
 expect(value).toBeNull(); expect(captured.size).toBe(0); expect(element.style.cursor).toBe('')
 expect(applyOptions).toHaveBeenLastCalledWith({handleScroll:originalScroll,handleScale:originalScale})
})
it('blocks Shift trading actions during placement and on empty history', () => {
 blocked=true; pointer('pointerdown',100,100,true); element.click()
 expect(value).toBeNull(); expect(pan).not.toHaveBeenCalled(); expect(tradingClick).not.toHaveBeenCalled()
 blocked=false; data=[]; pointer('pointerdown',100,100,true); element.click(); expect(value).toBeNull(); expect(tradingClick).not.toHaveBeenCalled()
})
it('ignores axes, indicators and unmodified gestures; leaves replay shortcuts available', () => {
 pointer('pointerdown',410,100,true); pointer('pointerdown',100,310,true); pointer('pointerdown')
 expect(pan).toHaveBeenCalledTimes(3); expect(value).toBeNull()
 pointer('pointerdown',100,100,true)
 const key=new KeyboardEvent('keydown',{key:'ArrowRight',shiftKey:true,ctrlKey:true,cancelable:true}); window.dispatchEvent(key)
 expect(key.defaultPrevented).toBe(false); expect(value).not.toBeNull()
})
it('cancels when placement starts or candle anchors become unrevealed', () => {
 pointer('pointerdown',100,100,true); blocked=true; pointer('pointermove',200,50); expect(value).toBeNull()
 blocked=false; pointer('pointerdown',100,100,true); pointer('pointermove',200,50); pointer('pointerup',200,50)
 data=data.slice(0,15); controller.validate(); expect(value).toBeNull()
})
it('removes listeners on dispose, including global handlers', () => {
 pointer('pointerdown',100,100,true); controller.dispose(); applyOptions.mockClear()
 pointer('pointerdown',100,100,true); pointer('pointermove',200,50); pointer('pointerup',200,50); element.click()
 expect(pan).toHaveBeenCalledOnce(); expect(tradingClick).toHaveBeenCalledOnce(); expect(value).toBeNull(); expect(applyOptions).not.toHaveBeenCalled()
})
it('ignores another pointer and suppresses wheel only while measuring', () => {
 pointer('pointerdown',100,100,true); pointer('pointermove',200,50,false,element,2); expect(value!.end.index).toBe(10)
 const e=new WheelEvent('wheel',{bubbles:true,cancelable:true}); element.dispatchEvent(e); expect(e.defaultPrevented).toBe(true)
 pointer('pointermove',200,50); pointer('pointerup',200,50)
 const after=new WheelEvent('wheel',{bubbles:true,cancelable:true}); element.dispatchEvent(after); expect(after.defaultPrevented).toBe(false)
})
it('preserves nested native axis options when the chart mutates resolved options', () => {
 const options={handleScroll:{pressedMouseMove:true},handleScale:{axisPressedMouseMove:{price:true,time:true}}}
 const spy=vi.spyOn(chart,'options').mockReturnValue(options as ReturnType<IChartApi['options']>)
 applyOptions.mockImplementation(next=>{if(next.handleScale===false) {options.handleScale.axisPressedMouseMove.price=false; options.handleScale.axisPressedMouseMove.time=false}})
 pointer('pointerdown',100,100,true); pointer('pointermove',200,50); pointer('pointerup',200,50)
 expect(applyOptions).toHaveBeenLastCalledWith({handleScroll:{pressedMouseMove:true},handleScale:{axisPressedMouseMove:{price:true,time:true}}})
 applyOptions.mockReset(); spy.mockRestore()
})
it('leaves keyboard-triggered trading-control clicks available after completion', () => {
 pointer('pointerdown',100,100,true); pointer('pointermove',200,50); pointer('pointerup',200,50)
 const button=document.createElement('button'), handler=vi.fn(); button.addEventListener('click',handler); document.body.append(button)
 button.click(); expect(handler).toHaveBeenCalledOnce(); button.remove()
})
