import { FOLLOW_RIGHT_OFFSET } from './chartSync'
import { EntryLines, type EntryOverlay } from './entryOverlays'
import { DraftStopAnnotation, useDraftStopAnnotation } from './DraftStopAnnotation'
import { StopLines } from './stopLabels'
import type { StopOverlay } from './stopOverlays'
import { useStopDrag, type StopInteraction } from './useStopDrag'
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CandlestickSeries, CrosshairMode, ColorType, LineStyle, createChart, type IChartApi, type ISeriesApi, type Time } from 'lightweight-charts'
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
  active?: boolean
  reviewing?: boolean
  instrument?: string
  priceLabel?: string
  priceDecimals?: number
  sessionId: string | null
  timeframe: Timeframe
  source: readonly Candle[]
  count: number
  synchronizer: ChartSynchronizer
  stopInteraction?: StopInteraction
  stops: StopOverlay[]
  entries?: EntryOverlay[]
  onConfirmStop?: () => void
  confirmStopDisabled?: boolean
  positions: Position[]
  draftReference?: number | null
  placement: StopDraft | null
  onPick: (price: number) => void
  settings: IndicatorSettings
  onSettingsChange: (id: number, settings: IndicatorSettings) => void
  onTimeframeChange: (id: number, timeframe: Timeframe) => void
}

export const ChartPane = memo(function ChartPane({ instrument = 'EURUSD', priceLabel = 'Bid', priceDecimals = 5, id, active = false, reviewing = false, sessionId, timeframe, source, count, synchronizer, onTimeframeChange, settings, onSettingsChange, positions, stops, placement, draftReference = null, onPick, stopInteraction, entries = [], onConfirmStop, confirmStopDisabled }: ChartPaneProps) {
  const [readiness, setReadiness] = useState('')
  const container = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const timeSlots = useRef<ChartTimeSlots | null>(null)
  const updateSettings = useCallback((next: IndicatorSettings) => onSettingsChange(id, next), [id, onSettingsChange])
  const indicatorsRef = useRef<IndicatorSeries | null>(null)
  const savePriceRef = useRef<(() => void) | null>(null)
  const stopLines = useRef<StopLines | null>(null)
  const draftAnnotation = useRef<HTMLDivElement>(null)
  const entryLines = useRef<EntryLines | null>(null)
  const previousSettings = useRef<IndicatorSettings | null>(null)
  const unregisterRef = useRef<(() => void) | null>(null)
  const previous = useRef<{ source: readonly Candle[]; count: number; bars: ReplayBars; timeframe: Timeframe; synchronizer: ChartSynchronizer } | null>(null)

  useStopDrag(container, chartRef, seriesRef, stopLines, positions, synchronizer, stopInteraction, !!placement)

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
      timeScale: { borderColor: '#354250', timeVisible: true, secondsVisible: false, fixLeftEdge: false, fixRightEdge: false, rightOffset: FOLLOW_RIGHT_OFFSET },
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
      priceFormat: { type: 'price', precision: priceDecimals, minMove: 10 ** -priceDecimals },
    })
    stopLines.current = new StopLines(series)
    entryLines.current = new EntryLines(series)
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
      entryLines.current?.dispose()
      entryLines.current = null
      stopLines.current?.dispose()
      stopLines.current = null
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      previous.current = null
    }
  }, [id])

  useEffect(() => {
    seriesRef.current?.applyOptions({ priceFormat: { type: 'price', precision: priceDecimals, minMove: 10 ** -priceDecimals } })
    chartRef.current?.applyOptions({ localization: { priceFormatter: (price: number) => price.toFixed(priceDecimals) } })
  }, [priceDecimals])

  useEffect(() => {
    const element = container.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      if (!chartRef.current || placement || stopInteraction?.preview) return
      const box = element.getBoundingClientRect(), chart = chartRef.current
      const x = event.clientX - box.left, y = event.clientY - box.top
      if (x < 0 || x >= box.width || y < 0 || y >= chart.panes().reduce((height, pane) => height + pane.getHeight(), 0)) return
      synchronizer.activate(id)
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.height : 1)
      if (x >= chart.timeScale().width()) {
        // Only the candle pane's price axis controls its vertical range.
        if (y >= chart.panes()[0].getHeight()) return
        event.preventDefault(); event.stopPropagation()
        const scale = seriesRef.current!.priceScale(), range = scale.getVisibleRange()
        if (!range || !Number.isFinite(delta) || delta === 0) return
        const middle = (range.from + range.to) / 2
        const half = (range.to - range.from) / 2 * Math.exp(Math.max(-100, Math.min(100, delta)) * 0.002)
        const next = { from: middle - half, to: middle + half }
        if (!Number.isFinite(next.from) || !Number.isFinite(next.to) || next.from >= next.to) return
        scale.applyOptions({ autoScale: false })
        scale.setVisibleRange(next)
        savePriceRef.current?.()
        return
      }
      event.preventDefault(); event.stopPropagation()
      synchronizer.wheel(id, delta)
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
    const advancing = !reviewing && !!last && last.source === source && last.synchronizer === synchronizer && last.timeframe === timeframe && count > last.count
    const bars = replace ? new ReplayBars(timeframe) : last.bars
    const dirty = bars.advance(source, count)
    const candles = bars.candles
    const required = indicatorWarmupRequirement(settings)
    const completed = Math.max(0, candles.length - (count ? 1 : 0))
    setReadiness(!required ? '' : completed < required ? `Indicators warming up: ${completed} / ${required} completed ${timeframe} candles` : `Indicators ready · ${required}+ completed ${timeframe} candles`)
    performanceValue(`chart.${id}.cursor`, count)
    performanceValue(`chart.${id}.time`, candles.at(-1)?.time ?? 0)
    if (!replace && dirty === candles.length && previousSettings.current === settings) {
      synchronizer.refresh(id, advancing)
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
    }, replace ? 0 : dirty, advancing)
    performanceEnd('chart.pane', frame)
    previousSettings.current = settings
    previous.current = { source, count, bars, timeframe, synchronizer }
  }, [id, source, count, synchronizer, timeframe, settings, reviewing])

  useLayoutEffect(() => {
    stopLines.current!.update(stops)
  }, [stops])

  useLayoutEffect(() => { entryLines.current!.update(entries) }, [entries])

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

  useDraftStopAnnotation(draftAnnotation, container, chartRef, seriesRef, placement, draftReference, onPick)

  return (
    <section data-active={active} className={`chart-pane${placement ? " placing-stop" : ""}`} aria-label={`Chart ${id + 1}: ${instrument === '6E' ? 'EURUSD 6E' : instrument} ${timeframe} ${instrument === '6E' ? 'trade prices' : priceLabel.toLowerCase()}`}
      onPointerDownCapture={() => synchronizer.activate(id)}
      onPointerMoveCapture={(event) => { if (event.buttons) synchronizer.activate(id) }}>
      <div className="pane-toolbar">
        <span className="instrument"><strong>{instrument === '6E' ? 'EURUSD 6E' : instrument}</strong>{instrument !== '6E' && <span className="bid-label">{priceLabel}</span>}</span>
        <label>Timeframe <select aria-label={`Chart ${id + 1} timeframe`} value={timeframe}
          onChange={(event) => { synchronizer.activate(id); onTimeframeChange(id, event.target.value as Timeframe) }}>
          {timeframe === 'M1' && <option value="M1">M1 (legacy)</option>}
          {VISIBLE_TIMEFRAMES.map((option) => <option key={option} value={option}>{option}</option>)}
        </select></label>
        <IndicatorControls key={timeframe} id={id} settings={settings} readiness={readiness} onChange={updateSettings} />
      </div>
      <div className="chart-plot">
        <div ref={container} className="chart-canvas" aria-hidden="true" />
        {placement && onConfirmStop && <DraftStopAnnotation element={draftAnnotation} selected={placement.price !== null} onConfirm={onConfirmStop} disabled={confirmStopDisabled} />}
      </div>
    </section>
  )
})
