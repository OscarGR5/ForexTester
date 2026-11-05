import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import type { IChartApi, UTCTimestamp } from 'lightweight-charts'
import type { Candle } from './history'
import { firstRegressionObservation } from './regressionChannel'

interface AnchorOptions {
  element: HTMLDivElement
  chart: IChartApi
  enabled: () => boolean
  candles: () => readonly { time: UTCTimestamp }[]
  source: () => readonly Candle[]
  count: () => number
  onAnchor: (timestamp: number) => void
}

// Own the full Ctrl gesture before the chart, trade placement, SL dragging,
// and ruler handlers. A disabled shortcut never owns ordinary chart events.
export function bindRegressionAnchor({ element, chart, enabled, candles, source, count, onAnchor }: AnchorOptions) {
  const plot = element.closest('.chart-plot') ?? element
  let pointer: number | null = null, swallowMouse = false
  const consume = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation() }
  const down = (event: PointerEvent) => {
    swallowMouse = false
    if (!enabled() || !event.ctrlKey || event.button !== 0 || !plot.contains(event.target as Node)) return
    const box = element.getBoundingClientRect(), x = event.clientX - box.left, y = event.clientY - box.top
    if (x < 0 || x >= chart.timeScale().width() || y < 0 || y >= chart.panes()[0].getHeight()) return
    consume(event); pointer = event.pointerId; swallowMouse = true
    const time = chart.timeScale().coordinateToTime(x)
    if (typeof time !== 'number') return
    const bars = candles()
    let low = 0, high = bars.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (bars[mid].time < time) low = mid + 1
      else high = mid
    }
    // Projected indicator slots and empty future margin are not candles.
    if (bars[low]?.time !== time) return
    const index = firstRegressionObservation(source(), time * 1000, count())
    if (index < count()) onAnchor(source()[index].timestamp)
  }
  const move = (event: PointerEvent) => { if (pointer === event.pointerId) consume(event) }
  const up = (event: PointerEvent) => { if (pointer === event.pointerId) { consume(event); pointer = null } }
  const cancel = () => { pointer = null; swallowMouse = false }
  const mouse = (event: MouseEvent) => { if (swallowMouse && (pointer !== null || plot.contains(event.target as Node))) consume(event) }
  window.addEventListener('pointerdown', down, true)
  window.addEventListener('pointermove', move, true); window.addEventListener('pointerup', up, true)
  window.addEventListener('pointercancel', cancel, true); window.addEventListener('blur', cancel)
  for (const type of ['mousedown', 'mouseup', 'click', 'dblclick'] as const) window.addEventListener(type, mouse, true)
  return () => {
    cancel()
    window.removeEventListener('pointerdown', down, true)
    window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true)
    window.removeEventListener('pointercancel', cancel, true); window.removeEventListener('blur', cancel)
    for (const type of ['mousedown', 'mouseup', 'click', 'dblclick'] as const) window.removeEventListener(type, mouse, true)
  }
}

export function useRegressionAnchor(container: RefObject<HTMLDivElement | null>, chartRef: RefObject<IChartApi | null>,
  enabled: boolean, candles: () => readonly { time: UTCTimestamp }[], source: readonly Candle[], count: number, onAnchor: (timestamp: number) => void) {
  const latest = useRef({ enabled, candles, source, count, onAnchor })
  useLayoutEffect(() => { latest.current = { enabled, candles, source, count, onAnchor } })
  useEffect(() => {
    const element = container.current, chart = chartRef.current
    if (!element || !chart) return
    return bindRegressionAnchor({ element, chart, enabled: () => latest.current.enabled,
      candles: () => latest.current.candles(), source: () => latest.current.source, count: () => latest.current.count,
      onAnchor: timestamp => latest.current.onAnchor(timestamp) })
  }, [container, chartRef])
}
