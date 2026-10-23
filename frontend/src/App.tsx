import { useEffect, useRef, useState, type FormEvent } from 'react'
import { CandlestickSeries, ColorType, createChart, type IChartApi, type ISeriesApi, type Time } from 'lightweight-charts'
import { fetchHistory, toBidChartCandles, validateDateRange, type DateRange, type HistoryResponse } from './history'

const DEFAULT_RANGE: DateRange = { from: '2024-01-09', to: '2024-01-10' }

export function App() {
  const [from, setFrom] = useState(DEFAULT_RANGE.from)
  const [to, setTo] = useState(DEFAULT_RANGE.to)
  const [requestedRange, setRequestedRange] = useState<DateRange>(DEFAULT_RANGE)
  const [history, setHistory] = useState<HistoryResponse | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const chartContainer = useRef<HTMLDivElement>(null)
  const chart = useRef<IChartApi | null>(null)
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null)

  useEffect(() => {
    const container = chartContainer.current
    if (!container) return
    const instance = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#171e28' },
        textColor: '#a7b3c1',
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: '#26313d' },
        horzLines: { color: '#26313d' },
      },
      rightPriceScale: { borderColor: '#354250' },
      timeScale: { borderColor: '#354250', timeVisible: true, secondsVisible: false },
      localization: {
        timeFormatter: (time: Time) => typeof time === 'number'
          ? `${new Date(time * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`
          : String(time),
      },
    })
    chart.current = instance
    series.current = instance.addSeries(CandlestickSeries, {
      upColor: '#4aa99a', downColor: '#d27d82',
      borderUpColor: '#4aa99a', borderDownColor: '#d27d82',
      wickUpColor: '#4aa99a', wickDownColor: '#d27d82',
      priceFormat: { type: 'price', precision: 5, minMove: 0.00001 },
    })
    return () => {
      series.current = null
      chart.current = null
      instance.remove()
    }
  }, [])

  useEffect(() => {
    const candles = history ? toBidChartCandles(history) : []
    series.current?.setData(candles)
    if (candles.length > 0) chart.current?.timeScale().fitContent()
  }, [history])

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
    const range = { from, to }
    const validationError = validateDateRange(range)
    setFormError(validationError)
    if (!validationError) setRequestedRange(range)
  }

  const todayUtc = new Date().toISOString().slice(0, 10)

  return (
    <main className="app-shell">
      <header className="app-header"><h1>ForexTester</h1></header>
      <form className="chart-toolbar" onSubmit={loadData}>
        <div className="instrument" aria-label="Chart instrument and timeframe">
          <strong>EURUSD</strong><span>M1</span><span className="bid-label">Bid</span>
        </div>
        <div className="date-controls">
          <label>Start date <input aria-label="Start date" type="date" value={from} max={todayUtc} onChange={(event) => { setFrom(event.target.value); setFormError(null) }} /></label>
          <label>End date <input aria-label="End date" type="date" value={to} max={todayUtc} onChange={(event) => { setTo(event.target.value); setFormError(null) }} /></label>
          <button type="submit">Load Data</button>
        </div>
      </form>
      {formError && <p className="form-error" role="alert">{formError}</p>}
      <section className="chart-workspace" aria-label="EURUSD M1 bid candlestick chart">
        <div ref={chartContainer} className="chart-canvas" aria-hidden="true" />
        {status === 'loading' && <div className="chart-message" role="status">Loading EURUSD M1 bid candles…</div>}
        {status === 'error' && <div className="chart-message" role="alert"><p>{error}</p><button type="button" onClick={() => setRequestedRange({ ...requestedRange })}>Retry</button></div>}
        {status === 'ready' && history?.bid.length === 0 && <div className="chart-message" role="status">No bid candles are available for this period.</div>}
      </section>
      <p className="chart-note">UTC dates · Start inclusive · End exclusive · Up to 7 completed days</p>
    </main>
  )
}
