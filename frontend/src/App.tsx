import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { CandlestickSeries, ColorType, createChart, type CandlestickData, type Time, type UTCTimestamp } from 'lightweight-charts'
import { ChartSynchronizer } from './chartSync'
import { fetchHistory, TIMEFRAMES, toBidChartCandles, validateDateRange, type DateRange, type HistoryResponse, type Timeframe } from './history'

const DEFAULT_RANGE: DateRange = { from: '2024-01-09', to: '2024-01-10' }
const DEFAULT_TIMEFRAMES: Timeframe[] = ['M1', 'M5', 'H1']

interface ChartPaneProps {
  id: number
  timeframe: Timeframe
  candles: CandlestickData<UTCTimestamp>[]
  synchronizer: ChartSynchronizer
  onTimeframeChange: (id: number, timeframe: Timeframe) => void
}

function ChartPane({ id, timeframe, candles, synchronizer, onTimeframeChange }: ChartPaneProps) {
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!container.current) return
    const chart = createChart(container.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#171e28' },
        textColor: '#a7b3c1',
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: '#26313d' },
        horzLines: { color: '#26313d' },
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
      upColor: '#4aa99a', downColor: '#d27d82',
      borderUpColor: '#4aa99a', borderDownColor: '#d27d82',
      wickUpColor: '#4aa99a', wickDownColor: '#d27d82',
      priceFormat: { type: 'price', precision: 5, minMove: 0.00001 },
    })
    series.setData(candles)
    const unregister = synchronizer.register(id, chart, series, candles, timeframe)
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
      unregister()
      chart.remove()
    }
  }, [id, candles, synchronizer, timeframe])

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
  const synchronizer = useMemo(() => new ChartSynchronizer(history?.bid.length ? {
    from: history.bid[0].timestamp / 1000,
    to: history.bid[history.bid.length - 1].timestamp / 1000,
  } : undefined), [history])
  const candles = useMemo(() => Object.fromEntries(TIMEFRAMES.map((timeframe) => [timeframe, history ? toBidChartCandles(history, timeframe) : []])) as Record<Timeframe, CandlestickData<UTCTimestamp>[]>, [history])

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
      </form>
      {formError && <p className="form-error" role="alert">{formError}</p>}
      <div className="chart-workspace" aria-label="EURUSD bid chart workspace">
        <div className="chart-stack" style={{ gridTemplateRows: `repeat(${chartCount}, minmax(300px, 1fr))` }}>
          {timeframes.slice(0, chartCount).map((timeframe, id) => <ChartPane key={id} id={id} timeframe={timeframe}
            candles={candles[timeframe]} synchronizer={synchronizer} onTimeframeChange={changeTimeframe} />)}
        </div>
        {status === 'loading' && <div className="chart-message" role="status">Loading EURUSD M1 bid candles…</div>}
        {status === 'error' && <div className="chart-message" role="alert"><p>{error}</p><button type="button" onClick={() => setRequestedRange({ ...requestedRange })}>Retry</button></div>}
        {status === 'ready' && history?.bid.length === 0 && <div className="chart-message" role="status">No bid candles are available for this period.</div>}
      </div>
      <p className="chart-note">UTC dates · Start inclusive · End exclusive · Up to 7 completed days</p>
    </main>
  )
}
