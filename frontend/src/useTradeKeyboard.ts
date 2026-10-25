import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { keyboardContextBlocked } from './useReplayKeyboard'

export function useTradeKeyboard(options: {
  blocked: boolean
  buy: RefObject<HTMLButtonElement | null>
  sell: RefObject<HTMLButtonElement | null>
}) {
  const latest = useRef(options)
  useLayoutEffect(() => { latest.current = options })
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const current = latest.current
      if (current.blocked || event.repeat || event.ctrlKey || event.altKey || event.metaKey || event.isComposing || event.defaultPrevented) return
      const direction = event.key.toLowerCase()
      if ((direction !== 'b' && direction !== 's') || keyboardContextBlocked(event)) return
      const button = (direction === 'b' ? current.buy : current.sell).current
      // :disabled includes disabled ancestor fieldsets, unlike button.disabled.
      if (!button || button.matches(':disabled')) return
      button.click()
      event.preventDefault()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
}
