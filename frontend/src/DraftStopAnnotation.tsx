import { useLayoutEffect, type RefObject } from 'react'
import type { IChartApi, ISeriesApi, ISeriesPrimitive } from 'lightweight-charts'

export function useDraftStopAnnotation(element: RefObject<HTMLDivElement | null>, chartRef: RefObject<IChartApi | null>, seriesRef: RefObject<ISeriesApi<'Candlestick'> | null>, price: number | null) {
  useLayoutEffect(() => {
    const chart = chartRef.current, series = seriesRef.current
    if (!chart || !series || price === null) return
    // The chart's rendering lifecycle also covers price-axis drags and resize.
    const update = () => {
      const node = element.current, y = series.priceToCoordinate(price)
      if (!node) return
      const height = chart.panes()[0].getHeight(), width = chart.timeScale().width()
      node.hidden = y === null
      node.style.maxWidth = `${Math.max(0, width - 8)}px`
      node.style.left = `${Math.max(4, width - node.offsetWidth - 8)}px`
      node.style.top = `${Math.max(0, Math.min(height - node.offsetHeight, (y ?? 0) - node.offsetHeight / 2))}px`
      node.hidden = y === null || height < node.offsetHeight
    }
    const primitive: ISeriesPrimitive = { updateAllViews: update, attached: ({ requestUpdate }) => requestUpdate() }
    series.attachPrimitive(primitive)
    update()
    return () => { if (seriesRef.current === series) series.detachPrimitive(primitive) }
  }, [chartRef, seriesRef, element, price])
}

export function DraftStopAnnotation({ element, price, onConfirm, disabled }: {
  element: RefObject<HTMLDivElement | null>; price: number; onConfirm: () => void; disabled?: boolean
}) {
  return <div ref={element} className="draft-stop-annotation" role="group" aria-label="Draft stop-loss"
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
    <button type="button" className="confirm-draft-stop" aria-label="Confirm draft stop-loss" disabled={disabled} onClick={onConfirm}>
      <svg aria-hidden="true" viewBox="0 0 20 20" width="20" height="20"><path d="m4 10 4 4 8-8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
    </button>
    <span>Draft SL <span className="draft-stop-price">{price.toFixed(5)}</span></span>
  </div>
}
