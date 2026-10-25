// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useReplayKeyboard } from './useReplayKeyboard'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
it('has one effective listener in StrictMode, blocks inactive/draft/drag states and cleans up', async () => {
 const host = document.createElement('div'), root = createRoot(host)
 let enabled = true, busy = false, playing = false
 const navigate = vi.fn(() => true), onPlaying = vi.fn()
 function Harness() { useReplayKeyboard({ enabled, busy, playing, navigate, onPlaying }); return null }
 const key = (init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, cancelable: true, ...init })
  window.dispatchEvent(event); return event
 }
 const render = () => act(async () => root.render(<StrictMode><Harness /></StrictMode>))
 await render(); expect(key().defaultPrevented).toBe(true); expect(navigate).toHaveBeenCalledTimes(1)
 busy = true; await render(); expect(key().defaultPrevented).toBe(false); expect(navigate).toHaveBeenCalledTimes(1)
 busy = false; enabled = false; await render(); expect(key().defaultPrevented).toBe(false)
 enabled = true; playing = true; await render(); expect(key().defaultPrevented).toBe(false); expect(onPlaying).toHaveBeenCalledTimes(1)
 playing = false; await render()
 for (const init of [{ shiftKey: false }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }]) expect(key(init).defaultPrevented).toBe(false)
 navigate.mockReturnValue(false); expect(key().defaultPrevented).toBe(false)
 const calls = navigate.mock.calls.length
 await act(async () => root.unmount()); expect(key().defaultPrevented).toBe(false); expect(navigate).toHaveBeenCalledTimes(calls)
})
it.each(['dialog', 'indicators', 'execution', 'stop chooser'])('leaves arrow behavior alone for an open %s', async type => {
 const host = document.createElement('div'), root = createRoot(host), navigate = vi.fn(() => true)
 const overlay = document.createElement(type === 'dialog' ? 'dialog' : type === 'stop chooser' ? 'div' : 'details')
 if (type === 'dialog') overlay.setAttribute('open', '')
 else if (type === 'stop chooser') overlay.className = 'stop-selector'
 else { overlay.className = type === 'indicators' ? 'indicator-controls' : 'execution-details'; overlay.setAttribute('open', '') }
 document.body.append(overlay)
 function Harness() { useReplayKeyboard({ enabled: true, busy: false, playing: false, navigate, onPlaying: () => {} }); return null }
 try {
  await act(async () => root.render(<Harness />))
  const event = new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, cancelable: true })
  window.dispatchEvent(event); expect(event.defaultPrevented).toBe(false); expect(navigate).not.toHaveBeenCalled()
 } finally { await act(async () => root.unmount()); overlay.remove() }
})
