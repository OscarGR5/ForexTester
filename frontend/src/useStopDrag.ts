import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import type { StopLines } from './stopLabels'
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
  positions.flatMap(position => {
    const at = coordinate(position.stopPrice)
    return at !== null && Math.abs(at - y) <= 7 ? [{ position, distance: Math.abs(at - y) }] : []
  }).sort((a, b) => a.distance - b.distance).map(hit => hit.position)

export function useStopDrag(container: RefObject<HTMLDivElement | null>, chart: RefObject<IChartApi | null>,
  series: RefObject<ISeriesApi<'Candlestick'> | null>, labels: RefObject<Pick<StopLines, 'hitTest'> | null>, positions: Position[], synchronizer: ChartSynchronizer,
  interaction?: StopInteraction, placing = false) {
  const latest = useRef({ positions, interaction, placing })
  useLayoutEffect(() => { latest.current = { positions, interaction, placing } }, [positions, interaction, placing])
  useEffect(() => {
    const element = container.current
    if (!element) return
    let drag: { id: string; pointerId: number; price: number; offset: number } | null = null
    const enabled = () => !!latest.current.interaction?.enabled && !latest.current.placing
    const consume = (event: PointerEvent) => { event.preventDefault(); event.stopImmediatePropagation() }
    const reset = () => {
      const pointerId = drag?.pointerId
      drag = null
      if (pointerId !== undefined && element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId)
      latest.current.interaction?.onPreview(null)
      synchronizer.suspendCrosshair(false)
      element.style.cursor = ''
    }
    const begin = (id: string, event: PointerEvent, annotation: boolean) => {
      if (!enabled() || event.button !== 0) return
      const position = latest.current.positions.find(p => p.id === id)
      if (!position) return
      consume(event)
      const y = event.clientY - element.getBoundingClientRect().top
      const offset = annotation ? y - (series.current?.priceToCoordinate(position.stopPrice) ?? y) : 0
      drag = { id, pointerId: event.pointerId, price: position.stopPrice, offset }
      element.setPointerCapture(event.pointerId)
      synchronizer.suspendCrosshair(true)
      latest.current.interaction?.onPreview({ id, price: position.stopPrice })
      element.style.cursor = 'ns-resize'
    }
    const target = (event: PointerEvent) => {
      if (!enabled() || !series.current || !chart.current) return null
      const box = element.getBoundingClientRect(), y = event.clientY - box.top, x = event.clientX - box.left
      if (x < 0 || x > chart.current.timeScale().width() || y < 0 || y > chart.current.panes()[0].getHeight()) return null
      const id = labels.current?.hitTest(x, y)
      // A pending annotation consumes its own bounds; it must not target a line behind it.
      if (id) return latest.current.positions.some(p => p.id === id) ? { id, annotation: true } : null
      const hits = stopHitCandidates(latest.current.positions, y, price => series.current!.priceToCoordinate(price))
      const closest = hits[0]
      if (!closest) return null
      // Shared lines cannot identify a position. Use the separated annotations instead.
      const at = series.current.priceToCoordinate(closest.stopPrice)!
      if (hits.slice(1).some(p => Math.abs(series.current!.priceToCoordinate(p.stopPrice)! - at) < 0.000001)) return null
      return { id: closest.id, annotation: false }
    }
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return
      if (drag) { consume(event); return }
      const hit = target(event)
      if (hit) begin(hit.id, event, hit.annotation)
    }
    const move = (event: PointerEvent) => {
      if (!drag) { element.style.cursor = target(event) ? 'ns-resize' : ''; return }
      if (event.pointerId !== drag.pointerId) return
      consume(event)
      if (!enabled() || !latest.current.positions.some(p => p.id === drag!.id)) { reset(); return }
      const price = series.current?.coordinateToPrice(event.clientY - element.getBoundingClientRect().top - drag.offset)
      if (price !== null && price !== undefined && Number.isFinite(price)) {
        drag.price = Math.round(price * 100000) / 100000
        latest.current.interaction?.onPreview({ id: drag.id, price: drag.price })
      }
    }
    const up = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return
      consume(event)
      const completed = drag
      if (enabled() && latest.current.positions.some(p => p.id === completed.id)) latest.current.interaction?.onCommit(completed.id, completed.price)
      reset()
    }
    const cancel = () => { if (drag) reset() }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel() }
    element.addEventListener('pointerdown', down, true); element.addEventListener('pointermove', move, true)
    element.addEventListener('pointerup', up, true); element.addEventListener('pointercancel', cancel, true)
    element.addEventListener('lostpointercapture', cancel); window.addEventListener('keydown', key); window.addEventListener('blur', cancel)
    return () => {
      reset(); element.removeEventListener('pointerdown', down, true); element.removeEventListener('pointermove', move, true)
      element.removeEventListener('pointerup', up, true); element.removeEventListener('pointercancel', cancel, true)
      element.removeEventListener('lostpointercapture', cancel); window.removeEventListener('keydown', key); window.removeEventListener('blur', cancel)
    }
  }, [container, chart, series, labels, synchronizer])
  // Changing replay permissions cancels any in-progress drag before another observation.
  useEffect(() => { if (!interaction?.enabled || placing) container.current?.dispatchEvent(new Event('pointercancel')) }, [interaction?.enabled, placing, container])
}
