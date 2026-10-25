import { useOutsideInteraction } from './useOutsideInteraction'
import { useLayoutEffect, useRef, type ReactNode } from 'react'
export function ManagementDialog({ children, required, busy = false, onClose }: { children: ReactNode; required: boolean; busy?: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useOutsideInteraction(ref, {
    enabled: !required && !busy,
    onDismiss: () => onClose(),
    isInside: event => {
      const box = ref.current?.getBoundingClientRect()
      return !!box && event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom
    },
  })
  useLayoutEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = ref.current!
    if (dialog.showModal) dialog.showModal()
    else dialog.setAttribute('open', '') // DOM-only test environments.
    return () => { dialog.close?.(); previousFocus?.focus() }
  }, [])
  return <dialog ref={ref} className="management-dialog" aria-label="Manage backtests" onCancel={event=>{event.preventDefault();if(!required && !busy)onClose()}}>{children}</dialog>
}
