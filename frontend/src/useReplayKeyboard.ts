import { useEffect, useLayoutEffect, useRef } from 'react'

export function shortcutBlocked(event: KeyboardEvent): boolean {
  if (!event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing || event.defaultPrevented) return true
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return true
  const editing = (element: EventTarget | null) => element instanceof Element && !!element.closest('input, select, textarea, [contenteditable]:not([contenteditable="false"])')
  return editing(event.target) || editing(document.activeElement) ||
    !!document.querySelector('dialog[open], [role="dialog"], .indicator-controls[open], .execution-details[open], .stop-selector, .placing-stop')
}

export function useReplayKeyboard(options: {
  enabled: boolean; playing: boolean; busy: boolean
  navigate: (direction: 'backward' | 'forward') => boolean
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
      if (current.navigate(event.key === 'ArrowLeft' ? 'backward' : 'forward')) event.preventDefault()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
}
