// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useReplay } from './useReplay'
import { TIMEFRAME_MS, type Candle, type Timeframe } from './history'
import { useReplayKeyboard } from './useReplayKeyboard'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
it.each([false, true])('has one effective listener, preserves guards and cleans up with Ctrl=%s', async ctrlKey => {
 const host = document.createElement('div'), root = createRoot(host)
 let enabled = true, busy = false, playing = false
 const navigate = vi.fn(() => true), onPlaying = vi.fn()
 function Harness() { useReplayKeyboard({ enabled, busy, playing, navigate, onPlaying }); return null }
 const key = (init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, ctrlKey, cancelable: true, ...init })
  window.dispatchEvent(event); return event
 }
 const render = () => act(async () => root.render(<StrictMode><Harness /></StrictMode>))
 await render(); expect(key().defaultPrevented).toBe(true); expect(navigate).toHaveBeenCalledTimes(1); expect(navigate).toHaveBeenLastCalledWith('forward', ctrlKey ? 'M1' : undefined)
 busy = true; await render(); expect(key().defaultPrevented).toBe(false); expect(navigate).toHaveBeenCalledTimes(1)
 busy = false; enabled = false; await render(); expect(key().defaultPrevented).toBe(false)
 enabled = true; playing = true; await render(); expect(key().defaultPrevented).toBe(false); expect(onPlaying).toHaveBeenCalledTimes(1)
 playing = false; await render()
 for (const init of [{ shiftKey: false }, { ctrlKey: true, shiftKey: false }, { altKey: true }, { metaKey: true }, { isComposing: true }, { key: 'ArrowUp' }]) expect(key(init).defaultPrevented).toBe(false)
 const prevented = new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, ctrlKey, cancelable: true }); prevented.preventDefault()
 const beforePrevented = navigate.mock.calls.length; window.dispatchEvent(prevented); expect(navigate).toHaveBeenCalledTimes(beforePrevented)
 navigate.mockReturnValue(false); expect(key().defaultPrevented).toBe(false)
 const calls = navigate.mock.calls.length
 await act(async () => root.unmount()); expect(key().defaultPrevented).toBe(false); expect(navigate).toHaveBeenCalledTimes(calls)
})
it.each(['dialog', 'indicators', 'execution', 'stop chooser'].flatMap(type => [false, true].map(ctrlKey => ({ type, ctrlKey }))))('leaves arrows alone for an open $type with Ctrl=$ctrlKey', async ({ type, ctrlKey }) => {
 const host = document.createElement('div'), root = createRoot(host), navigate = vi.fn(() => true)
 const overlay = document.createElement(type === 'dialog' ? 'dialog' : type === 'stop chooser' ? 'div' : 'details')
 if (type === 'dialog') overlay.setAttribute('open', '')
 else if (type === 'stop chooser') overlay.className = 'stop-selector'
 else { overlay.className = type === 'indicators' ? 'indicator-controls' : 'execution-details'; overlay.setAttribute('open', '') }
 document.body.append(overlay)
 function Harness() { useReplayKeyboard({ enabled: true, busy: false, playing: false, navigate, onPlaying: () => {} }); return null }
 try {
  await act(async () => root.render(<Harness />))
  const event = new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, ctrlKey, cancelable: true })
  window.dispatchEvent(event); expect(event.defaultPrevented).toBe(false); expect(navigate).not.toHaveBeenCalled()
 } finally { await act(async () => root.unmount()); overlay.remove() }
})


it.each(['input', 'select', 'textarea', 'contenteditable'])('blocks both combinations while typing in %s, including focus outside the event target', async tag => {
 const root=createRoot(document.createElement('div')), navigate=vi.fn(()=>true)
 const editor=document.createElement(tag==='contenteditable'?'div':tag)
 if(tag==='contenteditable'){editor.setAttribute('contenteditable','true');editor.tabIndex=0}
 document.body.append(editor)
 function Harness(){useReplayKeyboard({enabled:true,busy:false,playing:false,navigate,onPlaying:()=>{}});return null}
 try {
  await act(async()=>root.render(<Harness/>))
  for(const ctrlKey of [false,true]) for(const target of [editor,window]) {
   editor.focus()
   const event=new KeyboardEvent('keydown',{key:'ArrowRight',shiftKey:true,ctrlKey,bubbles:true,cancelable:true})
   target.dispatchEvent(event)
   expect(event.defaultPrevented).toBe(false);expect(navigate).not.toHaveBeenCalled()
  }
 } finally {await act(async()=>root.unmount());editor.remove()}
})

it.each(['M5','M15','H1','H4','D1'] as Timeframe[])('overrides focused %s with M1 only for Ctrl + Shift', async timeframe => {
 const width=TIMEFRAME_MS[timeframe]/60000,base=Date.UTC(2024,0,9)
 const source:Candle[]=Array.from({length:width+3},(_,i)=>({timestamp:base+i*60000,open:1,high:2,low:1,close:1.5}))
 let replay!:ReturnType<typeof useReplay>
 const root=createRoot(document.createElement('div'))
 function Harness(){
  replay=useReplay(source)
  useReplayKeyboard({enabled:replay.active,busy:false,playing:replay.playing,onPlaying:()=>{},navigate:(direction,override)=>replay.navigate(direction,override??timeframe)})
  return null
 }
 const key=async(direction:'ArrowLeft'|'ArrowRight',ctrlKey:boolean)=>{
  const event=new KeyboardEvent('keydown',{key:direction,shiftKey:true,ctrlKey,cancelable:true})
  await act(async()=>window.dispatchEvent(event));return event
 }
 try {
  await act(async()=>root.render(<Harness/>));await act(async()=>replay.start())
  await key('ArrowRight',true);expect(replay.timestamp).toBe(source[1].timestamp)
  await key('ArrowLeft',true);expect(replay.reviewTimestamp).toBe(source[0].timestamp)
  expect(replay.timestamp).toBe(source[1].timestamp);expect(replay.displayCount).toBe(1)
  expect((await key('ArrowLeft',true)).defaultPrevented).toBe(false)
  await key('ArrowRight',true);expect(replay.reviewing).toBe(false);expect(replay.count).toBe(2)
  await key('ArrowRight',false);expect(replay.timestamp).toBe(source[width-1].timestamp)
  await key('ArrowRight',false);expect(replay.timestamp).toBe(source.at(-1)!.timestamp)
  await key('ArrowLeft',false);expect(replay.reviewTimestamp).toBe(source[width-1].timestamp)
 } finally {await act(async()=>root.unmount())}
})

it('uses real M1 observations across missing minutes and closures, bounded by review and rollover limits', async () => {
 const source=['2024-01-12T21:57Z','2024-01-12T21:58Z','2024-01-12T22:00Z','2024-01-14T22:00Z','2024-01-15T00:00Z']
  .map((date,index)=>({timestamp:Date.parse(date),open:1,high:2,low:1,close:1.5,instrumentId:index===4?202:101}))
 const original=JSON.stringify(source),root=createRoot(document.createElement('div'))
 let replay!:ReturnType<typeof useReplay>
 function Harness(){
  replay=useReplay(source,1)
  useReplayKeyboard({enabled:replay.active,busy:false,playing:replay.playing,onPlaying:()=>{},navigate:(direction,override)=>replay.navigate(direction,override??'D1',1)})
  return null
 }
 const key=async(key:string)=>{
  const event=new KeyboardEvent('keydown',{key,ctrlKey:true,shiftKey:true,cancelable:true})
  await act(async()=>window.dispatchEvent(event));return event
 }
 try {
  await act(async()=>root.render(<Harness/>));await act(async()=>replay.start())
  expect((await key('ArrowLeft')).defaultPrevented).toBe(false)
  for(const index of [2,3]){await key('ArrowRight');expect(replay.timestamp).toBe(source[index].timestamp)}
  expect(replay.blocked).toBe(true);expect((await key('ArrowRight')).defaultPrevented).toBe(false)
  expect(replay.visible).toEqual(source.slice(0,4))
  await key('ArrowLeft');expect(replay.reviewTimestamp).toBe(source[2].timestamp)
  await key('ArrowLeft');expect(replay.reviewTimestamp).toBe(source[1].timestamp)
  expect((await key('ArrowLeft')).defaultPrevented).toBe(false)
  expect(replay.timestamp).toBe(source[3].timestamp);expect(replay.displayCount).toBe(2)
  await key('ArrowRight');await key('ArrowRight');expect(replay.reviewing).toBe(false)
  expect(replay.timestamp).toBe(source[3].timestamp);expect(JSON.stringify(source)).toBe(original)
 } finally {await act(async()=>root.unmount())}
})
