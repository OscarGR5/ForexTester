// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ManagementDialog } from './ManagementDialog'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
it.each([{ required: false, busy: false, closes: true }, { required: true, busy: false, closes: false }, { required: false, busy: true, closes: false }])('dismisses only optional idle management: %o', async ({ required, busy, closes }) => {
 const trigger = document.createElement('button'), host = document.createElement('div')
 document.body.append(trigger, host); trigger.focus()
 const root = createRoot(host), dismiss = vi.fn()
 try {
  await act(async () => root.render(<StrictMode><ManagementDialog required={required} busy={busy} onClose={dismiss}><input defaultValue="Preserved" /></ManagementDialog></StrictMode>))
  const dialog = host.querySelector('dialog')!, input = host.querySelector('input')!
  vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 100, right: 400, bottom: 400 } as DOMRect)
  const click = async (x: number, y: number) => act(async () => {
   dialog.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: x, clientY: y }))
   dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }))
  })
  await click(150, 150); expect(dismiss).not.toHaveBeenCalled()
  await act(async () => {
   dialog.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 150, clientY: 150 }))
   dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 10 }))
  }); expect(dismiss).not.toHaveBeenCalled()
  await click(10, 10); expect(dismiss).toHaveBeenCalledTimes(closes ? 1 : 0)
  dismiss.mockClear()
  await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(dismiss).toHaveBeenCalledTimes(closes ? 1 : 0)
  expect(input.value).toBe('Preserved'); expect(dialog.open).toBe(true)
  await act(async () => root.unmount()); expect(document.activeElement).toBe(trigger)
  dismiss.mockClear()
  await click(10, 10); expect(dismiss).not.toHaveBeenCalled()
 } finally { host.remove(); trigger.remove() }
})
