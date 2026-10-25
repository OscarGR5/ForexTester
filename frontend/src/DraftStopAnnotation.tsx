import { useLayoutEffect, type RefObject } from 'react'
import { LineStyle, type IChartApi, type IPriceLine, type ISeriesApi, type ISeriesPrimitive, type MouseEventParams, type Time } from 'lightweight-charts'
import type { StopDraft } from './TradingDock'

export function draftDistanceLabel(price: number, reference: number | null, direction: StopDraft['direction']) {
  if (reference === null || !Number.isFinite(reference) || reference <= 0) return 'Draft SL · Distance unavailable'
  const invalid = direction === 'buy' ? price >= reference : price <= reference
  return `Draft SL · ${(Math.abs(price - reference) / 0.0001).toFixed(1)} pips${invalid ? ' · Invalid SL side' : ''}`
}

// Pointer-frequency updates stay local to the chart. React receives only a
// selected price or a completed drag; neither path confirms an order.
export function useDraftStopAnnotation(element: RefObject<HTMLDivElement | null>, container: RefObject<HTMLDivElement | null>,
  chartRef: RefObject<IChartApi | null>, seriesRef: RefObject<ISeriesApi<'Candlestick'> | null>,
  draft: StopDraft | null, reference: number | null, onPick: (price: number) => void) {
  useLayoutEffect(() => {
    const chart = chartRef.current, series = seriesRef.current, canvas = container.current, node = element.current
    if (!chart || !series || !canvas || !node || !draft) return
    const plot = canvas.parentElement!
    let price = draft.price, line: IPriceLine | null = null
    let drag: { pointerId: number; original: number } | null = null
    const update = () => {
      const y = price === null ? null : series.priceToCoordinate(price)
      const height = chart.panes()[0].getHeight(), width = chart.timeScale().width()
      node.hidden = y === null
      node.style.maxWidth = `${Math.max(0, width - 8)}px`
      node.style.left = `${Math.max(4, width - node.offsetWidth - 8)}px`
      node.style.top = `${Math.max(0, Math.min(height - node.offsetHeight, (y ?? 0) - node.offsetHeight / 2))}px`
      node.hidden = y === null || height < node.offsetHeight
    }
    const preview = (next: number) => {
      price = next
      const invalid = reference !== null && (draft.direction === 'buy' ? price >= reference : price <= reference)
      const options = { price, color: invalid ? '#e2a2a6' : '#85c8d4', lineWidth: 2 as const, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '' }
      if (line) line.applyOptions(options); else line = series.createPriceLine(options)
      node.querySelector('[data-draft-label]')!.textContent = draftDistanceLabel(price, reference, draft.direction)
      node.dataset.invalid = String(invalid)
      node.dataset.price = String(price)
      update()
    }
    const roundedPrice = (y: number) => {
      const next = series.coordinateToPrice(y)
      return next !== null && Number.isFinite(next) && next > 0 ? Math.round(next * 100000) / 100000 : null
    }
    const eventPrice = (event: MouseEventParams<Time>) => {
      if (!event.point || event.paneIndex !== 0 || event.point.x < 0 || event.point.x >= chart.timeScale().width() || event.point.y < 0) return null
      return roundedPrice(event.point.y)
    }
    const move = (event: MouseEventParams<Time>) => {
      if (draft.price !== null || drag || !event.sourceEvent) return
      const next = eventPrice(event)
      if (next !== null) preview(next)
    }
    const leave = () => {
      if (draft.price !== null || drag) return
      price = null; node.hidden = true
      if (line) { series.removePriceLine(line); line = null }
    }
    const click = (event: MouseEventParams<Time>) => {
      const next = eventPrice(event)
      if (draft.price === null && next !== null) onPick(next)
    }
    const consume = (event: PointerEvent) => { event.preventDefault(); event.stopImmediatePropagation() }
    const down = (event: PointerEvent) => {
      if (draft.price === null || event.button !== 0 || drag || (event.target as Element).closest('button')) return
      const box = canvas.getBoundingClientRect(), x = event.clientX - box.left, y = event.clientY - box.top
      const at = series.priceToCoordinate(draft.price)
      const onLabel = node.contains(event.target as Node)
      if (!onLabel && (at === null || Math.abs(at - y) > 7 || x < 0 || x >= chart.timeScale().width() || y < 0 || y > chart.panes()[0].getHeight())) return
      consume(event)
      drag = { pointerId: event.pointerId, original: draft.price }
      plot.setPointerCapture(event.pointerId)
      node.querySelector('button')!.disabled = true
      plot.style.cursor = 'ns-resize'
    }
    const pointerMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return
      consume(event)
      const y = Math.max(0, Math.min(chart.panes()[0].getHeight(), event.clientY - canvas.getBoundingClientRect().top))
      const next = roundedPrice(y)
      if (next !== null) preview(next)
    }
    const finish = (commit: boolean) => {
      if (!drag) return
      const completed = drag; drag = null
      if (plot.hasPointerCapture(completed.pointerId)) plot.releasePointerCapture(completed.pointerId)
      plot.style.cursor = ''
      if (commit && price !== null) onPick(price)
      else preview(completed.original)
      node.querySelector('button')!.disabled = confirmDisabled
    }
    const confirmDisabled = node.querySelector('button')!.disabled
    const up = (event: PointerEvent) => { if (drag && event.pointerId === drag.pointerId) { consume(event); finish(true) } }
    const cancel = () => finish(false)
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel() }
    const primitive: ISeriesPrimitive = { updateAllViews: update, attached: ({ requestUpdate }) => requestUpdate() }
    series.attachPrimitive(primitive)
    if (price !== null && price > 0) preview(price)
    else node.hidden = true
    chart.applyOptions({ handleScroll: false, handleScale: false })
    chart.subscribeCrosshairMove(move); chart.subscribeClick(click)
    plot.addEventListener('pointerdown', down, true); plot.addEventListener('pointermove', pointerMove, true); plot.addEventListener('pointerup', up, true)
    plot.addEventListener('pointerleave', leave); plot.addEventListener('pointercancel', cancel); plot.addEventListener('lostpointercapture', cancel)
    window.addEventListener('blur', cancel); window.addEventListener('keydown', key)
    return () => {
      cancel()
      plot.removeEventListener('pointerdown', down, true); plot.removeEventListener('pointermove', pointerMove, true); plot.removeEventListener('pointerup', up, true)
      plot.removeEventListener('pointerleave', leave); plot.removeEventListener('pointercancel', cancel); plot.removeEventListener('lostpointercapture', cancel)
      window.removeEventListener('blur', cancel); window.removeEventListener('keydown', key)
      chart.unsubscribeCrosshairMove(move); chart.unsubscribeClick(click)
      if (seriesRef.current === series) { series.detachPrimitive(primitive); if (line) series.removePriceLine(line) }
      chart.applyOptions({ handleScroll: true, handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true } })
    }
  }, [chartRef, seriesRef, container, element, draft, reference, onPick])
}

export function DraftStopAnnotation({ element, selected, onConfirm, disabled }: {
  element: RefObject<HTMLDivElement | null>; selected: boolean; onConfirm: () => void; disabled?: boolean
}) {
  return <div ref={element} className="draft-stop-annotation" role="group" aria-label="Draft stop-loss" hidden={!selected}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
    <button type="button" hidden={!selected} className="confirm-draft-stop" aria-label="Confirm draft stop-loss" disabled={disabled} onClick={onConfirm}>
      <svg aria-hidden="true" viewBox="0 0 20 20" width="20" height="20"><path d="m4 10 4 4 8-8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
    </button>
    <span data-draft-label>Draft SL</span>
  </div>
}
