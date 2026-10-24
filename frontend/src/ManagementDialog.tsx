import { useLayoutEffect, useRef, type ReactNode } from 'react'
export function ManagementDialog({ children, required, onClose }: { children: ReactNode; required: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const dialog = ref.current!
    if (dialog.showModal) dialog.showModal()
    else dialog.setAttribute('open', '') // DOM-only test environments.
    return () => { dialog.close?.() }
  }, [])
  return <dialog ref={ref} className="management-dialog" aria-label="Manage backtests" onCancel={event=>{event.preventDefault();if(!required)onClose()}}>{children}</dialog>
}
