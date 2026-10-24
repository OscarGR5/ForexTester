import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import type { Position } from './trading'
import type { ChartSynchronizer } from './chartSync'

export interface StopPreview { id: string; price: number }
export interface StopInteraction {
  enabled: boolean
  preview: StopPreview | null
  onPreview: (preview: StopPreview | null) => void
  onCommit: (id: string, price: number) => string | null
}
export const stopHitCandidates = (positions: Position[], y: number, coordinate: (price: number) => number | null) =>
  positions.filter(p => { const at = coordinate(p.stopPrice); return at !== null && Math.abs(at - y) <= 7 })

export function useStopDrag(container: RefObject<HTMLDivElement | null>, chart: RefObject<IChartApi | null>,
  series: RefObject<ISeriesApi<'Candlestick'> | null>, positions: Position[], synchronizer: ChartSynchronizer,
  interaction?: StopInteraction, placing = false) {
  const [choices, setChoices] = useState<Position[]>([])
  const latest = useRef({ positions, interaction, placing })
  useLayoutEffect(() => { latest.current = { positions, interaction, placing } }, [positions, interaction, placing])
  const start = useRef<(id: string, event: PointerEvent) => void>(() => {})
  useEffect(() => {
    const element = container.current
    if (!element) return
    let drag: { id: string; pointerId: number; price: number } | null = null
    const enabled = () => !!latest.current.interaction?.enabled && !latest.current.placing
    const consume = (event: PointerEvent) => { event.preventDefault(); event.stopImmediatePropagation() }
    const reset = () => {
      const pointerId = drag?.pointerId
      drag = null
      if (pointerId !== undefined && element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId)
      latest.current.interaction?.onPreview(null)
      synchronizer.suspendCrosshair(false)
      element.style.cursor = ''; setChoices([])
    }
    const begin = (id: string, event: PointerEvent) => {
      if (!enabled() || event.button !== 0) return
      const position = latest.current.positions.find(p => p.id === id)
      if (!position) return
      consume(event); setChoices([])
      drag = { id, pointerId: event.pointerId, price: position.stopPrice }
      element.setPointerCapture(event.pointerId)
      synchronizer.suspendCrosshair(true)
      latest.current.interaction?.onPreview({ id, price: position.stopPrice })
      element.style.cursor = 'ns-resize'
    }
    start.current = begin
    const candidates = (event: PointerEvent) => {
      if (!enabled() || !series.current || !chart.current) return []
      const box = element.getBoundingClientRect(), y = event.clientY - box.top, x = event.clientX - box.left
      if (x < 0 || x > chart.current.timeScale().width() || y < 0 || y > chart.current.panes()[0].getHeight()) return []
      return stopHitCandidates(latest.current.positions, y, price => series.current!.priceToCoordinate(price))
    }
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return
      const hits = candidates(event)
      if (hits.length > 1) { consume(event); setChoices(hits) }
      else if (hits.length === 1) begin(hits[0].id, event)
      else setChoices([])
    }
    const move = (event: PointerEvent) => {
      if (!drag) { element.style.cursor = candidates(event).length ? 'ns-resize' : ''; return }
      consume(event)
      if (!enabled() || !latest.current.positions.some(p => p.id === drag!.id)) { reset(); return }
      const price = series.current?.coordinateToPrice(event.clientY - element.getBoundingClientRect().top)
      if (price !== null && price !== undefined && Number.isFinite(price)) {
        drag.price = Math.round(price * 100000) / 100000
        latest.current.interaction?.onPreview({ id: drag.id, price: drag.price })
      }
    }
    const up = (event: PointerEvent) => {
      if (!drag) return
      consume(event)
      const completed = drag
      if (enabled()) latest.current.interaction?.onCommit(completed.id, completed.price)
      reset()
    }
    const cancel = () => { if (drag) reset(); else setChoices([]) }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel() }
    element.addEventListener('pointerdown', down, true); element.addEventListener('pointermove', move, true)
    element.addEventListener('pointerup', up, true); element.addEventListener('pointercancel', cancel, true)
    element.addEventListener('lostpointercapture', cancel); window.addEventListener('keydown', key); window.addEventListener('blur', cancel)
    return () => {
      reset(); element.removeEventListener('pointerdown', down, true); element.removeEventListener('pointermove', move, true)
      element.removeEventListener('pointerup', up, true); element.removeEventListener('pointercancel', cancel, true)
      element.removeEventListener('lostpointercapture', cancel); window.removeEventListener('keydown', key); window.removeEventListener('blur', cancel)
    }
  }, [container, chart, series, synchronizer])
  // Changing replay permissions cancels any in-progress drag before another observation.
  useEffect(() => { if (!interaction?.enabled || placing) container.current?.dispatchEvent(new Event('pointercancel')) }, [interaction?.enabled, placing, container])
  return { choices, begin: (id: string, event: PointerEvent) => start.current(id, event) }
}
