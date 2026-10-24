import { useStopDrag, type StopInteraction } from './useStopDrag'
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CandlestickSeries, CrosshairMode, ColorType, LineStyle, createChart, type IChartApi, type IPriceLine, type ISeriesApi, type Time, type MouseEventParams } from 'lightweight-charts'
import { ChartTimeSlots } from './chartTimeSlots'
import { performanceStart, performanceEnd, performanceCount, performanceValue } from './replayPerformance'
import { readUi, validPriceView, writeUi, type PriceView } from './uiPreferences'
import { ChartSynchronizer } from './chartSync'
import { IndicatorControls } from './IndicatorControls'
import { IndicatorSeries } from './indicatorSeries'
import type { IndicatorSettings } from './indicators'
import { ReplayBars } from './replayBars'
import { indicatorWarmupRequirement } from './indicatorSettings'
import { VISIBLE_TIMEFRAMES, type Timeframe, type Candle } from './history'
import type { Position } from './trading'
import type { StopDraft } from './TradingDock'

interface ChartPaneProps {
  id: number
  instrument?: string
  sessionId: string | null
  timeframe: Timeframe
  source: readonly Candle[]
  count: number
  synchronizer: ChartSynchronizer
  stopInteraction?: StopInteraction
  positions: Position[]
  placement: StopDraft | null
  onPick: (price: number) => void
  settings: IndicatorSettings
  onSettingsChange: (id: number, settings: IndicatorSettings) => void
  onTimeframeChange: (id: number, timeframe: Timeframe) => void
}

export const ChartPane = memo(function ChartPane({ instrument = 'EURUSD', id, sessionId, timeframe, source, count, synchronizer, onTimeframeChange, settings, onSettingsChange, positions, placement, onPick, stopInteraction }: ChartPaneProps) {
  const [readiness, setReadiness] = useState('')
  const container = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const timeSlots = useRef<ChartTimeSlots | null>(null)
  const updateSettings = useCallback((next: IndicatorSettings) => onSettingsChange(id, next), [id, onSettingsChange])
  const indicatorsRef = useRef<IndicatorSeries | null>(null)
  const savePriceRef = useRef<(() => void) | null>(null)
  const stopLines = useRef(new Map<string, IPriceLine>())
  const previousSettings = useRef<IndicatorSettings | null>(null)
  const unregisterRef = useRef<(() => void) | null>(null)
  const previous = useRef<{ source: readonly Candle[]; count: number; bars: ReplayBars; timeframe: Timeframe; synchronizer: ChartSynchronizer } | null>(null)

  const stopDrag = useStopDrag(container, chartRef, seriesRef, positions, synchronizer, stopInteraction, !!placement)

  useLayoutEffect(() => {
    if (!container.current) return
    const chart = createChart(container.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#131722' },
        textColor: '#b2b5be',
        attributionLogo: true,
        panes: { separatorColor: '#b2b5be', separatorHoverColor: '#d1d4dc' },
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { visible: false },
      },
      handleScale: { mouseWheel: false },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#9598a1', style: LineStyle.Dashed, width: 1 },
        horzLine: { color: '#9598a1', style: LineStyle.Dashed, width: 1 },
      },
      rightPriceScale: { borderColor: '#354250' },
      timeScale: { borderColor: '#354250', timeVisible: true, secondsVisible: false, fixLeftEdge: true, fixRightEdge: true },
      localization: {
        timeFormatter: (time: Time) => typeof time === 'number'
          ? `${new Date(time * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`
          : String(time),
      },
    })
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#ffffff', downColor: '#2962ff',
      borderUpColor: '#ffffff', borderDownColor: '#ffffff',
      wickUpColor: '#ffffff', wickDownColor: '#ffffff',
      priceFormat: { type: 'price', precision: 5, minMove: 0.00001 },
    })
    chartRef.current = chart
    seriesRef.current = series
    timeSlots.current = new ChartTimeSlots(chart)
    indicatorsRef.current = new IndicatorSeries(chart)
    return () => {
      savePriceRef.current?.()
      unregisterRef.current?.()
      unregisterRef.current = null
      indicatorsRef.current?.dispose()
      indicatorsRef.current = null
      timeSlots.current = null
      previousSettings.current = null
      stopLines.current.clear()
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      previous.current = null
    }
  }, [id])

  useEffect(() => {
    const element = container.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      if (!chartRef.current || placement || stopInteraction?.preview) return
      const box = element.getBoundingClientRect(), chart = chartRef.current
      if (event.clientX - box.left > chart.timeScale().width() || event.clientY - box.top >= chart.panes().reduce((height, pane) => height + pane.getHeight(), 0)) return
      event.preventDefault(); event.stopPropagation()
      synchronizer.wheel(id, event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.height : 1))
    }
    element.addEventListener('wheel', wheel, { passive: false, capture: true })
    return () => element.removeEventListener('wheel', wheel, true)
  }, [id, synchronizer, placement, stopInteraction?.preview])

  useEffect(() => {
    if (!container.current || typeof ResizeObserver === 'undefined') return
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => synchronizer.refresh(id))
    })
    observer.observe(container.current)
    return () => { observer.disconnect(); cancelAnimationFrame(frame) }
  }, [id, synchronizer])

  useLayoutEffect(() => {
    const chart = chartRef.current!
    const series = seriesRef.current!
    // Register once per session; live data changes update the existing entry.
    const unregister = synchronizer.register(id, chart, series, [], 'M1')
    unregisterRef.current = unregister
    let firstFrame = 0
    let secondFrame = 0
    if (typeof requestAnimationFrame === 'function') {
      firstFrame = requestAnimationFrame(() => {
        secondFrame = requestAnimationFrame(() => synchronizer.refresh(id))
      })
    }
    return () => {
      if (firstFrame) cancelAnimationFrame(firstFrame)
      if (secondFrame) cancelAnimationFrame(secondFrame)
      if (unregisterRef.current === unregister) {
        unregister()
        unregisterRef.current = null
      }
    }
  }, [id, synchronizer])

  useLayoutEffect(() => {
    const frame = performanceStart()
    const series = seriesRef.current!
    const last = previous.current
    const replace = !last || last.synchronizer !== synchronizer || last.timeframe !== timeframe ||
      source !== last.source || count < last.count || last.count === 0
    const bars = replace ? new ReplayBars(timeframe) : last.bars
    const dirty = bars.advance(source, count)
    const candles = bars.candles
    const required = indicatorWarmupRequirement(settings)
    const completed = Math.max(0, candles.length - (count ? 1 : 0))
    setReadiness(!required ? '' : completed < required ? `Indicators warming up: ${completed} / ${required} completed ${timeframe} candles. Continue replay or reduce the indicator periods.` : `Indicators ready · ${required}+ completed ${timeframe} candles`)
    performanceValue(`chart.${id}.cursor`, count)
    performanceValue(`chart.${id}.time`, candles.at(-1)?.time ?? 0)
    if (!replace && dirty === candles.length && previousSettings.current === settings) {
      previous.current = { source, count, bars, timeframe, synchronizer }
      performanceEnd('chart.pane', frame)
      return
    }
    synchronizer.update(id, candles, timeframe, () => {
      timeSlots.current!.prepare(candles, replace)
      const prices = performanceStart()
      if (replace) { performanceCount('candles.setData'); series.setData(candles) }
      else {
        // Revisit the old tail: it may be a newly completed higher-timeframe bucket.
        for (let index = dirty; index < candles.length; index++) { performanceCount('candles.update'); series.update(candles[index]) }
      }
      performanceEnd('candles.series', prices)
      return indicatorsRef.current!.update(candles, settings, timeframe, replace || previousSettings.current !== settings)
    }, replace ? 0 : dirty)
    performanceEnd('chart.pane', frame)
    previousSettings.current = settings
    previous.current = { source, count, bars, timeframe, synchronizer }
  }, [id, source, count, synchronizer, timeframe, settings])

  useLayoutEffect(() => {
    const series = seriesRef.current!
    const ids = new Set(positions.map((position) => position.id))
    for (const [id, line] of stopLines.current) {
      if (!ids.has(id)) { series.removePriceLine(line); stopLines.current.delete(id) }
    }
    for (const position of positions) {
      const ordinal = Number(position.id.split('-').at(-1))
      const options = { price: stopInteraction?.preview?.id === position.id ? stopInteraction.preview.price : position.stopPrice, color: ordinal % 2 ? '#ef9a9a' : '#ffcc80', lineWidth: 1 as const,
        lineStyle: ordinal % 2 ? LineStyle.Dashed : LineStyle.Dotted, axisLabelVisible: true,
        title: '' }
      const line = stopLines.current.get(position.id)
      if (line) line.applyOptions(options)
      else stopLines.current.set(position.id, series.createPriceLine(options))
    }
  }, [positions, stopInteraction?.preview])

  useEffect(() => {
    const scale = seriesRef.current!.priceScale()
    const stored = readUi(sessionId, `price:${id}:${timeframe}`, null as PriceView | null, (v): v is PriceView | null => v === null || validPriceView(v))
    if (stored) { scale.applyOptions({ autoScale: stored.autoScale }); if (!stored.autoScale && stored.range) scale.setVisibleRange(stored.range) }
    const save = () => {
      if (!seriesRef.current || !scale.getVisibleRange || !scale.options) return
      const autoScale = scale.options().autoScale
      writeUi(sessionId, `price:${id}:${timeframe}`, { autoScale, range: autoScale ? null : scale.getVisibleRange() })
    }
    savePriceRef.current = save
    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = () => { if (!timer) timer = setTimeout(() => { timer = null; save() }, 250) }
    const element = container.current
    element?.addEventListener('pointerup', schedule); element?.addEventListener('wheel', schedule)
    window.addEventListener('pagehide', save); document.addEventListener('visibilitychange', save)
    return () => { if (timer) clearTimeout(timer); save(); element?.removeEventListener('pointerup', schedule); element?.removeEventListener('wheel', schedule); window.removeEventListener('pagehide', save); document.removeEventListener('visibilitychange', save) }
  }, [sessionId, id, timeframe])

  useLayoutEffect(() => {
    const chart = chartRef.current!, series = seriesRef.current!
    if (!placement) return
    let line: IPriceLine | null = null
    const preview = (price: number) => {
      const options = { price, color: '#85c8d4', lineWidth: 2 as const, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'Draft SL' }
      if (line) line.applyOptions(options); else line = series.createPriceLine(options)
    }
    if (placement.price !== null && placement.price > 0) preview(placement.price)
    const getPrice = (event: MouseEventParams<Time>) => {
      if (!event.point || event.paneIndex !== 0 || event.point.y < 0) return null
      const price = series.coordinateToPrice(event.point.y)
      return price !== null && Number.isFinite(price) && price > 0 ? Math.round(price * 100000) / 100000 : null
    }
    const move = (event: MouseEventParams<Time>) => { const price = getPrice(event); if (placement.price === null && price !== null) preview(price) }
    const click = (event: MouseEventParams<Time>) => { const price = getPrice(event); if (placement.price === null && price !== null) onPick(price) }
    chart.applyOptions({ handleScroll: false, handleScale: false })
    chart.subscribeCrosshairMove(move); chart.subscribeClick(click)
    return () => { chart.unsubscribeCrosshairMove(move); chart.unsubscribeClick(click); if (line) series.removePriceLine(line); chart.applyOptions({ handleScroll: true, handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true } }) }
  }, [placement, onPick])

  return (
    <section className={`chart-pane${placement ? " placing-stop" : ""}`} aria-label={`Chart ${id + 1}: ${instrument} ${timeframe} ${instrument === '6E' ? 'trade prices' : 'bid'}`}
      onPointerDownCapture={() => synchronizer.activate(id)}
      onPointerMoveCapture={(event) => { if (event.buttons) synchronizer.activate(id) }}>
      <div className="pane-toolbar">
        <span className="instrument"><strong>{instrument}</strong><span className="bid-label">{instrument === '6E' ? 'Trade' : 'Bid'}</span></span>
        <label>Timeframe <select aria-label={`Chart ${id + 1} timeframe`} value={timeframe}
          onChange={(event) => onTimeframeChange(id, event.target.value as Timeframe)}>
          {timeframe === 'M1' && <option value="M1">M1 (legacy)</option>}
          {VISIBLE_TIMEFRAMES.map((option) => <option key={option} value={option}>{option}</option>)}
        </select></label>
        {readiness && <span className="indicator-readiness" role="status">{readiness}</span>}
        <IndicatorControls key={timeframe} id={id} settings={settings} onChange={updateSettings} />
      </div>
      {stopDrag.choices.length > 1 && <div className="stop-selector" role="group" aria-label="Select overlapping stop-loss">
        <span>Hold a position button and drag vertically:</span>
        {stopDrag.choices.map(p => <button key={p.id} onPointerDown={event => stopDrag.begin(p.id, event.nativeEvent)}>{p.id} · {p.direction} · SL {p.stopPrice.toFixed(5)}</button>)}
      </div>}
      <div ref={container} className="chart-canvas" aria-hidden="true" />
    </section>
  )
})
