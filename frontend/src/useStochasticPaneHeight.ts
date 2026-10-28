import { useLayoutEffect, type RefObject } from 'react'
import type { IChartApi } from 'lightweight-charts'
import { readUi, validPaneShare, writeUi } from './uiPreferences'

// Lightweight Charts 5.2 uses this minimum for native separator dragging.
const MIN_PANE_HEIGHT = 30

export function useStochasticPaneHeight(container: RefObject<HTMLDivElement | null>, chartRef: RefObject<IChartApi | null>, sessionId: string | null, slot: number, enabled: boolean) {
  useLayoutEffect(() => {
    const chart = chartRef.current, element = container.current
    if (!chart || !element || !enabled) return
    const field = `stochasticPane:${slot}`
    let desired = readUi(sessionId, field, 0.25, validPaneShare)
    let before: number | null = null
    const proportion = () => {
      const [price, stochastic] = chart.panes()
      if (!price || !stochastic) return null
      const total = price.getStretchFactor() + stochastic.getStretchFactor()
      const share = stochastic.getStretchFactor() / total
      return validPaneShare(share) ? share : null
    }
    const restore = () => {
      before = null
      const [price, stochastic] = chart.panes()
      if (!price || !stochastic) return
      const height = price.getHeight() + stochastic.getHeight()
      const minimum = height > 0 ? Math.min(0.5, MIN_PANE_HEIGHT / height) : 0
      // Clamp only the displayed split. Keep the user's intended proportion for
      // larger containers and never save a temporary initialization/resize split.
      const share = Math.max(minimum, Math.min(1 - minimum, desired))
      price.setStretchFactor(4 * (1 - share))
      stochastic.setStretchFactor(4 * share)
    }
    const start = () => { before = proportion() }
    const finish = () => {
      if (before === null) return
      const share = proportion()
      if (share !== null && Math.abs(share - before) > 1e-9) {
        desired = share
        writeUi(sessionId, field, share)
      }
      before = null
    }
    restore()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(restore)
    observer?.observe(element)
    // Observe native gestures without taking over their movement or targeting
    // the library's DOM. An ordinary chart drag leaves stretch factors unchanged.
    element.addEventListener('mousedown', start, true)
    element.addEventListener('touchstart', start, true)
    window.addEventListener('mouseup', finish)
    window.addEventListener('touchend', finish)
    window.addEventListener('touchcancel', finish)
    window.addEventListener('blur', finish)
    window.addEventListener('pagehide', finish)
    return () => {
      observer?.disconnect()
      element.removeEventListener('mousedown', start, true)
      element.removeEventListener('touchstart', start, true)
      window.removeEventListener('mouseup', finish)
      window.removeEventListener('touchend', finish)
      window.removeEventListener('touchcancel', finish)
      window.removeEventListener('blur', finish)
      window.removeEventListener('pagehide', finish)
    }
  }, [container, chartRef, sessionId, slot, enabled])
}
