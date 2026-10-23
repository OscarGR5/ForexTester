import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { CandlestickSeries, ColorType, LineStyle, createChart, type CandlestickData, type IChartApi, type IPriceLine, type ISeriesApi, type Time, type UTCTimestamp } from 'lightweight-charts'
import { ChartSynchronizer } from './chartSync'
import { useReplay } from './useReplay'
import { accountRiskError } from './risk'
import type { Position } from './trading'
import { useTrading } from './useTrading'
import { TradingPanel } from './TradingPanel'
import { IndicatorControls } from './IndicatorControls'
import { IndicatorSeries } from './indicatorSeries'
import { indicatorPreset, type IndicatorSettings } from './indicators'
import { fetchHistory, TIMEFRAMES, toBidChartCandles, validateDateRange, type DateRange, type HistoryResponse, type Timeframe } from './history'

const DEFAULT_RANGE: DateRange = { from: '2024-01-09', to: '2024-01-10' }
const DEFAULT_TIMEFRAMES: Timeframe[] = ['M1', 'M5', 'H1']

interface ChartPaneProps {
  id: number
  timeframe: Timeframe
  candles: CandlestickData<UTCTimestamp>[]
  synchronizer: ChartSynchronizer
  positions: Position[]
  settings: IndicatorSettings
  onSettingsChange: (id: number, settings: IndicatorSettings) => void
  onTimeframeChange: (id: number, timeframe: Timeframe) => void
}

function ChartPane({ id, timeframe, candles, synchronizer, onTimeframeChange, settings, onSettingsChange, positions }: ChartPaneProps) {
  const container = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const indicatorsRef = useRef<IndicatorSeries | null>(null)
  const stopLines = useRef(new Map<string, IPriceLine>())
  const previousSettings = useRef<IndicatorSettings | null>(null)
  const unregisterRef = useRef<(() => void) | null>(null)
  const previous = useRef<{ candles: typeof candles; timeframe: Timeframe; synchronizer: ChartSynchronizer } | null>(null)

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
      crosshair: {
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
    indicatorsRef.current = new IndicatorSeries(chart)
    return () => {
      unregisterRef.current?.()
      unregisterRef.current = null
      indicatorsRef.current?.dispose()
      indicatorsRef.current = null
      previousSettings.current = null
      stopLines.current.clear()
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      previous.current = null
    }
  }, [id])

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
    const series = seriesRef.current!
    const last = previous.current
    const replace = !last || last.synchronizer !== synchronizer || last.timeframe !== timeframe ||
      candles.length < last.candles.length || last.candles.length === 0
    synchronizer.update(id, candles, timeframe, () => {
      if (replace) series.setData(candles)
      else {
        // Revisit the old tail: it may be a newly completed higher-timeframe bucket.
        for (let index = last.candles.length - 1; index < candles.length; index++) series.update(candles[index])
      }
      return indicatorsRef.current!.update(candles, settings, timeframe, replace || previousSettings.current !== settings)
    })
    previousSettings.current = settings
    previous.current = { candles, timeframe, synchronizer }
  }, [id, candles, synchronizer, timeframe, settings])

  useLayoutEffect(() => {
    const series = seriesRef.current!
    const ids = new Set(positions.map((position) => position.id))
    for (const [id, line] of stopLines.current) {
      if (!ids.has(id)) { series.removePriceLine(line); stopLines.current.delete(id) }
    }
    for (const position of positions) {
      const ordinal = Number(position.id.split('-').at(-1))
      const overlapping = positions.filter((item) => item.stopPrice === position.stopPrice).map((item) => item.id)
      const options = { price: position.stopPrice, color: ordinal % 2 ? '#ef9a9a' : '#ffcc80', lineWidth: 1 as const,
        lineStyle: ordinal % 2 ? LineStyle.Dashed : LineStyle.Dotted, axisLabelVisible: true,
        title: `SL ${overlapping.join(' / ')} · ${position.stopPrice.toFixed(5)}` }
      const line = stopLines.current.get(position.id)
      if (line) line.applyOptions(options)
      else stopLines.current.set(position.id, series.createPriceLine(options))
    }
  }, [positions])

  return (
    <section className="chart-pane" aria-label={`Chart ${id + 1}: EURUSD ${timeframe} bid`}
      onPointerDownCapture={() => synchronizer.activate(id)}
      onPointerMoveCapture={(event) => { if (event.buttons) synchronizer.activate(id) }}
      onWheelCapture={() => synchronizer.activate(id)}>
      <div className="pane-toolbar">
        <span className="instrument"><strong>EURUSD</strong><span className="bid-label">Bid</span></span>
        <label>Timeframe <select aria-label={`Chart ${id + 1} timeframe`} value={timeframe}
          onChange={(event) => onTimeframeChange(id, event.target.value as Timeframe)}>
          {TIMEFRAMES.map((option) => <option key={option} value={option}>{option}</option>)}
        </select></label>
        <IndicatorControls key={timeframe} id={id} settings={settings} onChange={(next) => onSettingsChange(id, next)} />
      </div>
      <div ref={container} className="chart-canvas" aria-hidden="true" />
    </section>
  )
}

export function App() {
  const [from, setFrom] = useState(DEFAULT_RANGE.from)
  const [to, setTo] = useState(DEFAULT_RANGE.to)
  const [requestedRange, setRequestedRange] = useState<DateRange>(DEFAULT_RANGE)
  const [history, setHistory] = useState<HistoryResponse | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [chartCount, setChartCount] = useState(1)
  const [timeframes, setTimeframes] = useState<Timeframe[]>(DEFAULT_TIMEFRAMES)
  const [indicatorSettings, setIndicatorSettings] = useState<Partial<Record<Timeframe, IndicatorSettings>>[]>(() =>
    DEFAULT_TIMEFRAMES.map((timeframe) => ({ [timeframe]: indicatorPreset(timeframe) })))
  const replay = useReplay(history?.bid ?? null)
  const trading = useTrading(history, replay)
  const bounds = useMemo(() => replay.visible.length ? {
    from: replay.visible[0].timestamp / 1000,
    to: replay.visible[replay.visible.length - 1].timestamp / 1000,
  } : undefined, [replay.visible])
  // A new session resets the viewport and subscriptions, while panes retain their chart instances.
  const synchronizer = useMemo(() => new ChartSynchronizer(bounds), [history, replay.epoch])
  const candles = useMemo(() => Object.fromEntries(TIMEFRAMES.map((timeframe) =>
    [timeframe, toBidChartCandles({ bid: replay.visible }, timeframe)])) as Record<Timeframe, CandlestickData<UTCTimestamp>[]>, [replay.visible])

  useLayoutEffect(() => { synchronizer.advance(bounds) }, [synchronizer, bounds])

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setHistory(null)
    setStatus('loading')
    setError(null)
    fetchHistory(requestedRange, controller.signal)
      .then((result) => {
        if (!active) return
        setHistory(result)
        setStatus('ready')
      })
      .catch((reason: unknown) => {
        if (!active) return
        setError(reason instanceof Error ? reason.message : 'Historical data is unavailable.')
        setStatus('error')
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [requestedRange])

  function loadData(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    synchronizer.deactivate()
    const range = { from, to }
    const validationError = validateDateRange(range)
    setFormError(validationError)
    if (!validationError) setRequestedRange(range)
  }

  function changeTimeframe(id: number, timeframe: Timeframe) {
    synchronizer.deactivate()
    setIndicatorSettings((current) => current.map((settings, index) => index === id && !settings[timeframe]
      ? { ...settings, [timeframe]: indicatorPreset(timeframe) } : settings))
    setTimeframes((current) => current.map((value, index) => index === id ? timeframe : value))
  }

  const todayUtc = new Date().toISOString().slice(0, 10)

  return (
    <main className="app-shell">
      <header className="app-header"><h1>ForexTester</h1></header>
      <form className="chart-toolbar" onSubmit={loadData}>
        <fieldset className="layout-controls"><legend>Charts</legend>
          {[1, 2, 3].map((count) => <label key={count}><input type="radio" name="chart-count" value={count}
            checked={chartCount === count} onChange={() => { synchronizer.deactivate(); setChartCount(count) }} />{count}</label>)}
        </fieldset>
        <div className="date-controls">
          <label>Start date <input aria-label="Start date" type="date" value={from} max={todayUtc} onChange={(event) => { setFrom(event.target.value); setFormError(null) }} /></label>
          <label>End date <input aria-label="End date" type="date" value={to} max={todayUtc} onChange={(event) => { setTo(event.target.value); setFormError(null) }} /></label>
          <button type="submit">Load Data</button>
        </div>
        <div className="replay-controls" role="group" aria-label="Market replay">
          <button type="button" disabled={!replay.canStart || !!accountRiskError(trading.state.account)} onClick={replay.start}>Start Replay</button>
          <button type="button" disabled={!replay.canPlay} onClick={replay.play}>Play</button>
          <button type="button" disabled={!replay.canPause} onClick={replay.pause}>Pause</button>
          <button type="button" disabled={!replay.canNext} onClick={replay.next}>Next Candle</button>
          <button type="button" disabled={!replay.canRestart} onClick={replay.restart}>Restart</button>
          <span className="replay-status" role="status" aria-label="Replay status">{replay.status}</span>
          <time className="replay-clock" dateTime={replay.timestamp === null ? undefined : new Date(replay.timestamp).toISOString()}>
            {replay.timestamp === null ? 'Simulation clock: awaiting replay (UTC)' : `${new Date(replay.timestamp).toISOString().slice(0, 16).replace('T', ' ')} UTC`}
          </time>
          <span className="replay-progress" aria-label="Replay progress">{replay.revealed} / {replay.total} candles</span>
        </div>
      </form>
      {formError && <p className="form-error" role="alert">{formError}</p>}
      <div className="chart-workspace" aria-label="EURUSD bid chart workspace">
        <div className="chart-stack" style={{ gridTemplateRows: `repeat(${chartCount}, minmax(auto, 1fr))` }}>
          {timeframes.slice(0, chartCount).map((timeframe, id) => <ChartPane key={id} id={id} timeframe={timeframe}
            positions={trading.state.positions} candles={candles[timeframe]} synchronizer={synchronizer} onTimeframeChange={changeTimeframe}
            settings={indicatorSettings[id][timeframe]!} onSettingsChange={(chartId, next) => {
              synchronizer.deactivate()
              setIndicatorSettings((current) => current.map((value, index) => index === chartId ? { ...value, [timeframe]: next } : value))
            }} />)}
        </div>
        {status === 'loading' && <div className="chart-message" role="status">Loading EURUSD M1 bid candles…</div>}
        {status === 'error' && <div className="chart-message" role="alert"><p>{error}</p><button type="button" onClick={() => setRequestedRange({ ...requestedRange })}>Retry</button></div>}
        {status === 'ready' && history?.bid.length === 0 && <div className="chart-message" role="status">No bid candles are available for this period.</div>}
      </div>
      <TradingPanel onConfigureCommission={trading.configureCommission} onConfigure={trading.configure} state={trading.state} permission={trading.permission} onEntry={trading.enter} onCancel={trading.cancel} onClose={trading.close} onModifyStop={trading.modifyStop} />
      <p className="chart-note">UTC dates · Start inclusive · End exclusive · Up to 7 completed days</p>
    </main>
  )
}
