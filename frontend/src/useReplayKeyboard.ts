import { useEffect, useLayoutEffect, useRef } from 'react'

export function keyboardContextBlocked(event: KeyboardEvent): boolean {
  const editing = (element: EventTarget | null) => element instanceof Element && !!element.closest('input, select, textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"]')
  return editing(event.target) || editing(document.activeElement) ||
    !!document.querySelector('dialog[open], [role="dialog"], .indicator-controls[open], .execution-details[open], .stop-selector, .placing-stop')
}

export function shortcutBlocked(event: KeyboardEvent): boolean {
  return !event.shiftKey || event.altKey || event.metaKey || event.isComposing || event.defaultPrevented ||
    (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') || keyboardContextBlocked(event)
}

export function useReplayKeyboard(options: {
  enabled: boolean; playing: boolean; busy: boolean
  navigate: (direction: 'backward' | 'forward', timeframe?: 'M1') => boolean
  onPlaying: () => void
}) {
  const latest = useRef(options)
  useLayoutEffect(() => { latest.current = options })
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const current = latest.current
      if (!current.enabled || current.busy || shortcutBlocked(event)) return
      // Report disabled feedback without taking the browser's arrow behavior.
      if (current.playing) { current.onPlaying(); return }
      if (current.navigate(event.key === 'ArrowLeft' ? 'backward' : 'forward', event.ctrlKey ? 'M1' : undefined)) event.preventDefault()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
}
