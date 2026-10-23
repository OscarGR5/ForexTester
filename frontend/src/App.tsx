import { defaultWorkspace, readUi, useUiValue, validWorkspace, validPriceView, type PriceView, writeUi } from './uiPreferences'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { CandlestickSeries, ColorType, LineStyle, createChart, type IChartApi, type IPriceLine, type ISeriesApi, type Time } from 'lightweight-charts'
import { SessionControls } from './SessionControls'
import { useSessionPersistence } from './useSessionPersistence'
import { equitySummary, type Hydration, type SessionSnapshot, type WorkspaceSettings } from './sessionTypes'
import type { AnalyticsScope } from './analytics'
import { ChartSynchronizer } from './chartSync'
import { useReplay } from './useReplay'
import { accountRiskError } from './risk'
import type { Position } from './trading'
import { useTrading } from './useTrading'
import { TradingPanel } from './TradingPanel'
import { TradingJournal } from './TradingJournal'
import { IndicatorControls } from './IndicatorControls'
import { IndicatorSeries } from './indicatorSeries'
import { indicatorPreset, type IndicatorSettings } from './indicators'
import { HistoryLoader, ichimokuWarmup, replayStartIndex, type LoadProgress, type LoadedHistory } from './historyLoader'
import { ReplayBars } from './replayBars'
import { EquityChart } from './EquityChart'
import { TIMEFRAMES, type Candle, validateDateRange, type DateRange, type Timeframe } from './history'

const EMPTY_CANDLES: readonly Candle[] = []
const DEFAULT_RANGE: DateRange = { from: '2024-01-09', to: '2024-01-10' }

interface ChartPaneProps {
  id: number
  sessionId: string | null
  timeframe: Timeframe
  source: readonly Candle[]
  count: number
  synchronizer: ChartSynchronizer
  positions: Position[]
  settings: IndicatorSettings
  onSettingsChange: (id: number, settings: IndicatorSettings) => void
  onTimeframeChange: (id: number, timeframe: Timeframe) => void
}

function ChartPane({ id, sessionId, timeframe, source, count, synchronizer, onTimeframeChange, settings, onSettingsChange, positions }: ChartPaneProps) {
  const container = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const indicatorsRef = useRef<IndicatorSeries | null>(null)
  const stopLines = useRef(new Map<string, IPriceLine>())
  const previousSettings = useRef<IndicatorSettings | null>(null)
  const unregisterRef = useRef<(() => void) | null>(null)
  const previous = useRef<{ source: readonly Candle[]; count: number; bars: ReplayBars; timeframe: Timeframe; synchronizer: ChartSynchronizer } | null>(null)

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
      source !== last.source || count < last.count || last.count === 0
    const bars = replace ? new ReplayBars(timeframe) : last.bars
    const dirty = bars.advance(source, count)
    const candles = bars.candles
    synchronizer.update(id, candles, timeframe, () => {
      if (replace) series.setData(candles)
      else {
        // Revisit the old tail: it may be a newly completed higher-timeframe bucket.
        for (let index = dirty; index < candles.length; index++) series.update(candles[index])
      }
      return indicatorsRef.current!.update(candles, settings, timeframe, replace || previousSettings.current !== settings)
    }, replace ? 0 : dirty)
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
      const overlapping = positions.filter((item) => item.stopPrice === position.stopPrice).map((item) => item.id)
      const options = { price: position.stopPrice, color: ordinal % 2 ? '#ef9a9a' : '#ffcc80', lineWidth: 1 as const,
        lineStyle: ordinal % 2 ? LineStyle.Dashed : LineStyle.Dotted, axisLabelVisible: true,
        title: `SL ${overlapping.join(' / ')} · ${position.stopPrice.toFixed(5)}` }
      const line = stopLines.current.get(position.id)
      if (line) line.applyOptions(options)
      else stopLines.current.set(position.id, series.createPriceLine(options))
    }
  }, [positions])

  useEffect(() => {
    const scale = seriesRef.current!.priceScale()
    const stored = readUi(sessionId, `price:${id}:${timeframe}`, null as PriceView | null, (v): v is PriceView | null => v === null || validPriceView(v))
    if (stored) { scale.applyOptions({ autoScale: stored.autoScale }); if (!stored.autoScale && stored.range) scale.setVisibleRange(stored.range) }
    const save = () => {
      if (!seriesRef.current || !scale.getVisibleRange || !scale.options) return
      const autoScale = scale.options().autoScale
      writeUi(sessionId, `price:${id}:${timeframe}`, { autoScale, range: autoScale ? null : scale.getVisibleRange() })
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = () => { if (!timer) timer = setTimeout(() => { timer = null; save() }, 250) }
    const element = container.current
    element?.addEventListener('pointerup', schedule); element?.addEventListener('wheel', schedule)
    window.addEventListener('pagehide', save); document.addEventListener('visibilitychange', save)
    return () => { if (timer) clearTimeout(timer); save(); element?.removeEventListener('pointerup', schedule); element?.removeEventListener('wheel', schedule); window.removeEventListener('pagehide', save); document.removeEventListener('visibilitychange', save) }
  }, [sessionId, id, timeframe])

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
  const [history, setHistory] = useState<LoadedHistory | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [loader] = useState(() => new HistoryLoader())
  const [loadProgress, setLoadProgress] = useState<LoadProgress>({ completed: 0, total: 0 })
  const [replayStart, setReplayStart] = useState('')
  const [hydration, setHydration] = useState<Hydration | null>(null)
  const skipHistoryLoad = useRef(false)
  const tradingFrom = history?.tradingFrom ?? requestedRange.from
  const startMs = Date.parse(`${replayStart || `${tradingFrom}T00:00`}:00Z`)
  const startIndex = useMemo(() => replayStartIndex(history?.bid ?? [], startMs), [history, startMs])
  const replay = useReplay(history?.bid ?? null, startIndex, hydration ? { replay: hydration.checkpoint.replay, epoch: hydration.checkpoint.trading.session } : null)
  const trading = useTrading(history, replay, hydration)
  const bounds = useMemo(() => history?.bid.length && replay.count ? {
    from: history.bid[0].timestamp / 1000,
    to: history.bid[replay.count - 1].timestamp / 1000,
  } : undefined, [history, replay.count])
  const warmup = useMemo(() => ichimokuWarmup(history?.bid ?? [], startMs), [history, startMs])
  const workspace = useMemo<WorkspaceSettings>(() => defaultWorkspace(), [])
  const snapshot = useMemo<SessionSnapshot | null>(() => history ? ({ ledger: trading.equity, checkpoint: {
    replay: { started: replay.active, index: replay.active ? replay.count - 1 : null, timestamp: replay.timestamp,
      startIndex: replay.active ? replay.startIndex : startIndex, startTimestamp: startMs, speed: replay.speed, complete: replay.complete, playing: replay.playing },
    trading: trading.state, executionCursor: trading.executionCursor, equity: equitySummary(trading.equity), workspace,
  } }) : null, [history, trading.state, trading.equity, trading.executionCursor, replay.active, replay.count, replay.timestamp, replay.startIndex, replay.speed, replay.complete, replay.playing, startIndex, startMs, workspace])
  const sessions = useSessionPersistence({ history, snapshot, actionVersion: trading.actionVersion, pause: replay.pause,
    captureViewport: () => synchronizer.snapshot(),
    download: (range, progress) => new HistoryLoader().load(range, new AbortController().signal, progress ?? setLoadProgress),
    restore: (saved, source) => {
      skipHistoryLoad.current = true
      setHydration(saved); setHistory(source); setRequestedRange(saved.record.range)
      setFrom(saved.record.range.from); setTo(saved.record.range.to)
      setReplayStart(new Date(saved.checkpoint.replay.startTimestamp).toISOString().slice(0, 16))
      setStatus('ready'); setError(null); setFormError(null)
    },
    fresh: (range) => {
      setHydration(null); setHistory(null); setRequestedRange({ ...range }); setFrom(range.from); setTo(range.to)
    },
  })

  const [uiWorkspace, setUiWorkspace] = useUiValue(sessions.activeId, 'workspace', workspace, validWorkspace)
  const { chartCount, timeframes, indicators: indicatorSettings, statisticsScope, journalScope } = uiWorkspace
  const setChartCount = (chartCount: number) => setUiWorkspace((w) => ({ ...w, chartCount }))
  const setTimeframes = (update: (v: Timeframe[]) => Timeframe[]) => setUiWorkspace((w) => ({ ...w, timeframes: update(w.timeframes) }))
  const setIndicatorSettings = (update: (v: WorkspaceSettings['indicators']) => WorkspaceSettings['indicators']) => setUiWorkspace((w) => ({ ...w, indicators: update(w.indicators) }))
  const setStatisticsScope = (statisticsScope: AnalyticsScope) => setUiWorkspace((w) => ({ ...w, statisticsScope }))
  const setJournalScope = (journalScope: AnalyticsScope) => setUiWorkspace((w) => ({ ...w, journalScope }))
  const synchronizer = useMemo(() => {
    const sync = new ChartSynchronizer(bounds)
    sync.restore(readUi(sessions.activeId, 'workspace', workspace, validWorkspace).viewport)
    return sync
  }, [history, replay.epoch, sessions.activeId])
  useLayoutEffect(() => { synchronizer.advance(bounds) }, [synchronizer, bounds])
  useEffect(() => {
    if (!sessions.activeId) return
    const persist = () => {
      const stored = readUi(sessions.activeId, 'workspace', workspace, validWorkspace)
      const viewport = synchronizer.snapshot()
      if (JSON.stringify(viewport) !== JSON.stringify(stored.viewport)) writeUi(sessions.activeId, 'workspace', { ...stored, viewport })
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    synchronizer.onViewportChange = () => { if (!timer) timer = setTimeout(() => { timer = null; persist() }, 250) }
    const scroll = () => writeUi(sessions.activeId, 'scrollY', Math.max(0, Math.min(1000000, window.scrollY)))
    const hidden = () => { persist(); scroll() }
    window.addEventListener('pagehide', hidden); document.addEventListener('visibilitychange', hidden)
    const scrollY = readUi(sessions.activeId, 'scrollY', 0, (v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1000000)
    let frame = 0
    if (scrollY && typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(() => window.scrollTo(0, scrollY))
    return () => { if (timer) clearTimeout(timer); if (frame) cancelAnimationFrame(frame); synchronizer.onViewportChange = undefined; persist(); scroll(); window.removeEventListener('pagehide', hidden); document.removeEventListener('visibilitychange', hidden) }
  }, [sessions.activeId, synchronizer])

  useEffect(() => {
    if (!sessions.initialized || sessions.awaitingChoice) return
    if (skipHistoryLoad.current) { skipHistoryLoad.current = false; return }
    const controller = new AbortController()
    let active = true
    setHistory(null)
    setStatus('loading')
    setError(null)
    setReplayStart('')
    loader.load(requestedRange, controller.signal, (value) => { if (active) setLoadProgress(value) })
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
  }, [requestedRange, loader, sessions.initialized, sessions.awaitingChoice])

  function loadData(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    synchronizer.deactivate()
    const range = { from, to }
    const validationError = validateDateRange(range)
    setFormError(validationError)
    if (!validationError) void sessions.fresh(range)
  }

  function restart() {
    const valuable = trading.state.setups.length > 0 || trading.state.closed.length > 0 || trading.state.positions.length > 0 || trading.state.pending.length > 0
    if (valuable && !window.confirm('Restart this session? Trading records, journal notes and replay progress will be cleared and overwritten in autosaves. Cancel and choose New session to keep this backtest separately.')) return
    setHydration(null)
    replay.restart()
  }

  function changeTimeframe(id: number, timeframe: Timeframe) {
    synchronizer.deactivate()
    setIndicatorSettings((current) => current.map((settings, index) => index === id && !settings[timeframe]
      ? { ...settings, [timeframe]: indicatorPreset(timeframe) } : settings))
    setTimeframes((current) => current.map((value, index) => index === id ? timeframe : value))
  }

  const replayStartError = !Number.isFinite(startMs) || startMs < Date.parse(tradingFrom) || startMs >= Date.parse(requestedRange.to)
  const todayUtc = new Date().toISOString().slice(0, 10)

  return (
    <main className="app-shell">
      <header className="app-header"><h1>ForexTester</h1></header>
      <SessionControls sessions={sessions} range={{ from: tradingFrom, to: history?.to ?? requestedRange.to }} timestamp={replay.timestamp} />
      <fieldset className="workspace-controls" disabled={!sessions.initialized || sessions.busy || sessions.conflict || sessions.awaitingChoice} hidden={sessions.awaitingChoice}>
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
          <button type="button" disabled={!replay.canStart || replayStartError || !!accountRiskError(trading.state.account)} onClick={() => replay.start()}>Start Replay</button>
          <button type="button" disabled={!replay.canPlay} onClick={replay.play}>Play</button>
          <button type="button" disabled={!replay.canPause} onClick={replay.pause}>Pause</button>
          <button type="button" disabled={!replay.canNext} onClick={replay.next}>Next Candle</button>
          <button type="button" disabled={!replay.canRestart} onClick={restart}>Restart</button>
          <label>Replay speed <select aria-label="Replay speed" value={replay.speed} onChange={(event) => replay.setSpeed(Number(event.target.value) as 1 | 10 | 100)}>
            {[1, 10, 100].map((speed) => <option key={speed} value={speed}>{speed}×</option>)}
          </select></label>
          <label>Replay start (UTC) <input aria-label="Replay start (UTC)" type="datetime-local" disabled={replay.active || !history}
            min={`${tradingFrom}T00:00`} max={`${requestedRange.to}T00:00`} value={replayStart || `${tradingFrom}T00:00`}
            onChange={(event) => setReplayStart(event.target.value)} /></label>
          <span className="replay-status" role="status" aria-label="Replay status">{replay.status}</span>
          <time className="replay-clock" dateTime={replay.timestamp === null ? undefined : new Date(replay.timestamp).toISOString()}>
            {replay.timestamp === null ? 'Simulation clock: awaiting replay (UTC)' : `${new Date(replay.timestamp).toISOString().slice(0, 16).replace('T', ' ')} UTC`}
          </time>
          <span className="replay-progress" aria-label="Replay progress">{replay.active ? replay.revealed - replay.startIndex : 0} / {Math.max(0, replay.total - (replay.active ? replay.startIndex : startIndex))} candles</span>
        </div>
      </form>
      {history && <p className="chart-note">30-day pre-roll stays visible for indicators. Replay begins at the first available M1 candle at or after the chosen UTC start; earlier candles are context only.</p>}
      {history && !warmup.ready && <p className="coverage-warning" role="status">H4 Ichimoku warm-up incomplete: {warmup.count} prior H4 observations; {warmup.required} needed for the default displaced cloud at replay start.</p>}
      {history && replayStartError && <p className="form-error" role="alert">Choose a replay start within the requested trading interval.</p>}
      {formError && <p className="form-error" role="alert">{formError}</p>}
      <div className="chart-workspace" aria-label="EURUSD bid chart workspace">
        <div className="chart-stack" style={{ gridTemplateRows: `repeat(${chartCount}, minmax(auto, 1fr))` }}>
          {timeframes.slice(0, chartCount).map((timeframe, id) => <ChartPane key={id} id={id} timeframe={timeframe}
            sessionId={sessions.activeId} positions={trading.state.positions} source={history?.bid ?? EMPTY_CANDLES} count={replay.count} synchronizer={synchronizer} onTimeframeChange={changeTimeframe}
            settings={indicatorSettings[id][timeframe]!} onSettingsChange={(chartId, next) => {
              synchronizer.deactivate()
              setIndicatorSettings((current) => current.map((value, index) => index === chartId ? { ...value, [timeframe]: next } : value))
            }} />)}
        </div>
        {status === 'loading' && <div className="chart-message" role="status">Loading EURUSD bid/ask history · {loadProgress.completed} / {loadProgress.total} chunks complete…</div>}
        {status === 'error' && <div className="chart-message" role="alert"><p>{error}</p><button type="button" onClick={() => setRequestedRange({ ...requestedRange })}>Retry</button></div>}
        {status === 'ready' && history && startIndex >= history.bid.length && <div className="chart-message" role="status">No bid candles are available at or after the chosen replay start within this trading period.</div>}
      </div>
      <TradingPanel sessionId={sessions.activeId} onConfigureCommission={trading.configureCommission} onConfigure={trading.configure} state={trading.state} permission={trading.permission} onEntry={trading.enter} onCancel={trading.cancel} onClose={trading.close} onModifyStop={trading.modifyStop} />
      <TradingJournal sessionId={sessions.activeId} key={`${sessions.activeId}-${trading.state.session}`} state={trading.state} onUpdateSetup={trading.updateSetup} scope={statisticsScope} view={journalScope} onScopeChange={setStatisticsScope} onViewChange={setJournalScope} />
      <EquityChart sessionId={sessions.activeId} ledger={trading.equity} referenceBalance={trading.state.account.referenceBalance} />
      </fieldset>
      <p className="chart-note">UTC dates · Start inclusive · End exclusive · Up to 90 completed days</p>
    </main>
  )
}
