import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { keyboardContextBlocked } from './useReplayKeyboard'

export function useTradeKeyboard(options: {
  blocked: boolean
  buy: RefObject<HTMLButtonElement | null>
  sell: RefObject<HTMLButtonElement | null>
  confirm: RefObject<HTMLButtonElement | null>
  draftDirection: 'buy' | 'sell' | null
}) {
  const latest = useRef(options)
  useLayoutEffect(() => { latest.current = options })
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const current = latest.current
      if (current.blocked || event.repeat || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.isComposing || event.defaultPrevented) return
      const direction = event.key.toLowerCase()
      if (direction !== 'b' && direction !== 's') return
      let button: HTMLButtonElement | null
      if (current.draftDirection) {
        if (direction !== current.draftDirection[0]) return
        if (document.querySelector('dialog[open], [role="dialog"], [aria-modal="true"], .indicator-controls[open], .execution-details[open], .stop-selector')) return
        const interactive = (target: EventTarget | null) => {
          if (!(target instanceof Element)) return false
          // Only the dedicated SL input opts into directional confirmation.
          if (target.matches('.stop-placement input[data-draft-sl-price]:not(:disabled)')) return false
          return !!target.closest('button, input, select, textarea, a[href], summary, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="combobox"], [role="listbox"], [role="slider"], [role="spinbutton"]')
        }
        if (interactive(event.target) || interactive(document.activeElement)) return
        button = current.confirm.current
      } else {
        if (keyboardContextBlocked(event)) return
        button = (direction === 'b' ? current.buy : current.sell).current
      }
      // :disabled includes disabled ancestor fieldsets, unlike button.disabled.
      if (!button || button.matches(':disabled')) return
      button.click()
      event.preventDefault()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
}
