import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

// Share dismissal semantics across disclosures and optional native dialogs.
// Both pointer press and click must start outside, so dragging out of a panel
// never dismisses it. Escape is handled in capture before replay shortcuts.
export function useOutsideInteraction<T extends HTMLElement>(ref: RefObject<T | null>, {
  enabled = true, onDismiss, isInside,
}: { enabled?: boolean | (() => boolean); onDismiss: (escape: boolean) => void; isInside?: (event: MouseEvent | PointerEvent) => boolean }) {
  const latest = useRef({ enabled, onDismiss, isInside })
  useLayoutEffect(() => { latest.current = { enabled, onDismiss, isInside } })
  useEffect(() => {
    let pressedOutside = false
    const active = () => typeof latest.current.enabled === 'function' ? latest.current.enabled() : latest.current.enabled
    const inside = (event: MouseEvent | PointerEvent) => latest.current.isInside?.(event) ?? (!!ref.current && event.composedPath().includes(ref.current))
    const down = (event: PointerEvent) => { pressedOutside = !inside(event) }
    const click = (event: MouseEvent) => {
      if (active() && pressedOutside && !inside(event)) latest.current.onDismiss(false)
      pressedOutside = false
    }
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !active()) return
      event.preventDefault(); event.stopPropagation(); latest.current.onDismiss(true)
    }
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('click', click, true)
    document.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('click', click, true)
      document.removeEventListener('keydown', key, true)
    }
  }, [ref])
}

export function useDismissibleDetails() {
  const ref = useRef<HTMLDetailsElement>(null)
  useOutsideInteraction(ref, {
    // Read the native open property, including before the async toggle event.
    onDismiss: escape => {
      const details = ref.current
      if (!details?.open) return
      const restore = escape || details.contains(document.activeElement)
      details.open = false
      if (restore) details.querySelector('summary')?.focus()
    },
    isInside: event => !ref.current?.open || event.composedPath().includes(ref.current),
    enabled: () => !!ref.current?.open,
  })
  return ref
}
