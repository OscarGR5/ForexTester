// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useIndicatorKeyboard } from './useIndicatorKeyboard'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
it('toggles P once, preserves I, respects focus/dialog/modifier guards, and cleans up', async () => {
  const root = createRoot(document.createElement('div')), toggleUntaken = vi.fn(), toggleIchimoku = vi.fn()
  let blocked = false
  function Harness() { useIndicatorKeyboard({ blocked, toggleUntaken, toggleIchimoku }); return null }
  const render = () => act(async () => root.render(<StrictMode><Harness /></StrictMode>))
  const key = (init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key: 'p', bubbles: true, cancelable: true, ...init })
    window.dispatchEvent(event); return event
  }
  try {
    await render()
    expect(key().defaultPrevented).toBe(true); expect(toggleUntaken).toHaveBeenCalledTimes(1)
    key({ key: 'i' }); expect(toggleIchimoku).toHaveBeenCalledTimes(1)
    for (const init of [{ repeat: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }, { key: 'x' }]) expect(key(init).defaultPrevented).toBe(false)
    for (const tag of ['input', 'textarea', 'select', 'div']) {
      const editor = document.createElement(tag)
      if (tag === 'div') { editor.contentEditable = 'true'; editor.setAttribute('contenteditable', 'true'); editor.tabIndex = 0 }
      document.body.append(editor); editor.focus()
      expect(key().defaultPrevented).toBe(false)
      editor.remove()
    }
    const dialog = document.createElement('dialog'); dialog.open = true; document.body.append(dialog)
    expect(key().defaultPrevented).toBe(false); dialog.remove()
    const details = document.createElement('details'); details.className = 'indicator-controls'; details.open = true; document.body.append(details)
    expect(key().defaultPrevented).toBe(false); details.remove()
    blocked = true; await render(); expect(key().defaultPrevented).toBe(false)
    expect(toggleUntaken).toHaveBeenCalledTimes(1)
  } finally { await act(async () => root.unmount()) }
  expect(key().defaultPrevented).toBe(false)
})
