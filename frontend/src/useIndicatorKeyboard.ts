import { useEffect, useLayoutEffect, useRef } from 'react'
import { keyboardContextBlocked } from './useReplayKeyboard'

export function useIndicatorKeyboard(options: { blocked: boolean; toggleIchimoku: () => void; toggleUntaken: () => void }) {
  const latest = useRef(options)
  useLayoutEffect(() => { latest.current = options })
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const current = latest.current
      if (current.blocked || event.repeat || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.isComposing || event.defaultPrevented) return
      const key = event.key.toLowerCase()
      if (!['i', 'p'].includes(key) || keyboardContextBlocked(event)) return
      if (key === 'p') current.toggleUntaken()
      else current.toggleIchimoku()
      event.preventDefault()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
}
