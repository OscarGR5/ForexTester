import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts'
import { MeasurementPrimitive } from './MeasurementPrimitive'
import { nearestMeasurementAnchor, type Measurement } from './measurement'

interface MeasurementOptions {
  element: HTMLDivElement
  chart: IChartApi
  series: ISeriesApi<'Candlestick'>
  candles: () => readonly { time: UTCTimestamp }[]
  blocked: () => boolean
  setData: (value: Measurement | null) => void
}

// Native capture handlers run before Lightweight Charts and stop/order handlers.
// No chart data, React state, or cross-pane synchronization changes per pointer.
export function bindMeasurement({ element, chart, series, candles, blocked, setData }: MeasurementOptions) {
  let value: Measurement | null = null
  let gesture: { pointerId: number; x: number; y: number; moved: boolean; awaiting: boolean; finishing: boolean } | null = null
  let capture: number | null = null, swallowMouse = false
  let restore: (() => void) | null = null
  const consume = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation() }
  const release = () => {
    const id = capture; capture = null
    if (id !== null && element.hasPointerCapture(id)) element.releasePointerCapture(id)
  }
  const finish = () => { gesture = null; release(); restore?.(); restore = null; element.style.cursor = '' }
  const clear = () => { finish(); value = null; setData(null) }
  const point = (event: PointerEvent, inside: boolean) => {
    const box = element.getBoundingClientRect(), width = chart.timeScale().width(), height = chart.panes()[0].getHeight()
    let x = event.clientX - box.left, y = event.clientY - box.top
    if (inside && (x < 0 || x >= width || y < 0 || y >= height)) return null
    x = Math.max(0, Math.min(width - 1, x)); y = Math.max(0, Math.min(height - 1, y))
    const scale = chart.timeScale()
    return nearestMeasurementAnchor(candles(), scale.coordinateToLogical(x), series.coordinateToPrice(y), time => scale.timeToIndex(time))
  }
  const update = (event: PointerEvent) => {
    const end = point(event, false)
    if (value && end) { value = { start: value.start, end }; setData(value) }
  }
  const down = (event: PointerEvent) => {
    if (gesture) {
      consume(event)
      if (event.pointerId !== gesture.pointerId || event.button !== 0) return
      if (blocked()) { clear(); return }
      if (gesture.awaiting) {
        gesture.finishing = true; update(event)
        capture = event.pointerId; element.setPointerCapture(capture)
      }
      return
    }
    swallowMouse = false
    if (element.contains(event.target as Node)) {
      if (value && !event.shiftKey) { value = null; setData(null) }
    }
  }
  const start = (event: PointerEvent) => {
    if (!event.shiftKey || event.button !== 0 || event.pointerType === 'touch') return
    // Block Shift trading clicks even on an empty history or during placement.
    const box = element.getBoundingClientRect(), x = event.clientX - box.left, y = event.clientY - box.top
    if (x < 0 || x >= chart.timeScale().width() || y < 0 || y >= chart.panes()[0].getHeight()) return
    consume(event); swallowMouse = true
    if (blocked()) return
    const anchor = point(event, true)
    clear()
    if (!anchor) return
    value = { start: anchor, end: anchor }; setData(value)
    gesture = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false, awaiting: false, finishing: false }
    const options = chart.options(), scroll = structuredClone(options.handleScroll), scale = structuredClone(options.handleScale)
    chart.applyOptions({ handleScroll: false, handleScale: false })
    restore = () => chart.applyOptions({ handleScroll: scroll, handleScale: scale })
    capture = event.pointerId; element.setPointerCapture(capture); element.style.cursor = 'crosshair'
  }
  const move = (event: PointerEvent) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return
    consume(event)
    if (blocked()) { clear(); return }
    if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 3) gesture.moved = true
    update(event)
  }
  const up = (event: PointerEvent) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return
    consume(event); update(event)
    if (blocked()) { clear(); return }
    if (gesture.finishing || gesture.moved && !gesture.awaiting) finish()
    else { gesture.awaiting = true; release() }
  }
  const cancel = () => { if (gesture) clear() }
  const lost = () => { if (capture !== null) cancel() }
  const key = (event: KeyboardEvent) => { if (event.key === 'Escape') clear() }
  const mouse = (event: MouseEvent) => {
    if (gesture || swallowMouse && (element.contains(event.target as Node) || event.target === element.closest('.chart-pane'))) consume(event)
  }
  const wheel = (event: WheelEvent) => { if (gesture) consume(event) }
  window.addEventListener('pointerdown', down, true)
  element.addEventListener('pointerdown', start, true)
  window.addEventListener('pointermove', move, true); window.addEventListener('pointerup', up, true)
  window.addEventListener('pointercancel', cancel, true); element.addEventListener('lostpointercapture', lost)
  window.addEventListener('blur', cancel); window.addEventListener('keydown', key)
  for (const type of ['mousedown', 'mouseup', 'click', 'dblclick'] as const) window.addEventListener(type, mouse, true)
  window.addEventListener('wheel', wheel, { capture: true, passive: false })
  return {
    clear,
    validate() {
      if (value && [value.start, value.end].some(anchor => candles()[anchor.index]?.time !== anchor.time)) clear()
    },
    dispose(restoreInteractions = true) {
      if (!restoreInteractions) restore = null
      clear()
      window.removeEventListener('pointerdown', down, true); element.removeEventListener('pointerdown', start, true)
      window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', cancel, true); element.removeEventListener('lostpointercapture', lost)
      window.removeEventListener('blur', cancel); window.removeEventListener('keydown', key)
      for (const type of ['mousedown', 'mouseup', 'click', 'dblclick'] as const) window.removeEventListener(type, mouse, true)
      window.removeEventListener('wheel', wheel, true)
    },
  }
}

export function useMeasurement(container: RefObject<HTMLDivElement | null>, chartRef: RefObject<IChartApi | null>,
  seriesRef: RefObject<ISeriesApi<'Candlestick'> | null>, candles: () => readonly { time: UTCTimestamp }[],
  blocked: boolean, resetKey: string, pipSize: number,
  overlaps: (x: number, y: number, width: number, height: number) => boolean) {
  const latest = useRef({ candles, blocked, overlaps })
  const binding = useRef<ReturnType<typeof bindMeasurement> | null>(null)
  const dispose = useRef<(() => void) | null>(null)
  useLayoutEffect(() => {
    latest.current = { candles, blocked, overlaps }
    if (blocked) binding.current?.clear()
    else binding.current?.validate()
  })
  useLayoutEffect(() => { binding.current?.clear() }, [resetKey])
  useEffect(() => {
    const element = container.current, chart = chartRef.current, series = seriesRef.current
    if (!element || !chart || !series) return
    const primitive = new MeasurementPrimitive(pipSize, (...args) => latest.current.overlaps(...args))
    series.attachPrimitive(primitive)
    const controller = bindMeasurement({ element, chart, series, candles: () => latest.current.candles(), blocked: () => latest.current.blocked,
      setData: value => primitive.setData(value) })
    binding.current = controller
    let disposed = false
    const cleanup = () => {
      if (disposed) return
      disposed = true
      const attached = chartRef.current === chart && seriesRef.current === series
      if (!attached) primitive.detached()
      controller.dispose(attached)
      if (attached) series.detachPrimitive(primitive)
      if (binding.current === controller) binding.current = null
      if (dispose.current === cleanup) dispose.current = null
    }
    dispose.current = cleanup
    return cleanup
  }, [container, chartRef, seriesRef, resetKey, pipSize])
  return dispose
}
