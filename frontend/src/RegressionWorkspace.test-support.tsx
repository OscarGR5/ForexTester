import { stopOverlays } from './stopOverlays'
import { historyCandles } from './history'
// Regression composition for Tasks 1–19. Exercises current production chart,
// replay, trading, journal and persistence components with the former controls.
// The production three-phase application is covered separately in workflow tests.
import { ChartPane } from './ChartPane'
import { ChartTimeSlots } from './chartTimeSlots'
import { performanceStart, performanceEnd, performanceCount, performanceValue } from './replayPerformance.js'
import { defaultWorkspace, readUi, useUiValue, validWorkspace, validPriceView, type PriceView, writeUi } from './uiPreferences'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react'
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

export function RegressionWorkspace() {
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
  const startIndex = useMemo(() => replayStartIndex(history ? historyCandles(history) : [], startMs), [history, startMs])
  const replay = useReplay(history ? historyCandles(history) : null, startIndex, hydration ? { replay: hydration.checkpoint.replay, epoch: hydration.checkpoint.trading.session } : null)
  const trading = useTrading(history, replay, hydration)
  const bounds = useMemo(() => (history ? historyCandles(history).length : 0) && replay.count ? {
    from: historyCandles(history!)[0].timestamp / 1000,
    to: historyCandles(history!)[replay.count - 1].timestamp / 1000,
  } : undefined, [history, replay.count])
  const warmup = useMemo(() => ichimokuWarmup(history ? historyCandles(history) : [], startMs), [history, startMs])
  const workspace = useMemo<WorkspaceSettings>(() => ({ ...defaultWorkspace(), chartCount: 1, chartModes: undefined,
    timeframes: ['M1', 'M5', 'H1'], indicators: [{ M1: indicatorPreset('M1') }, { M5: indicatorPreset('M5') }, { H1: indicatorPreset('H1') }] }), [])
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
  const setStatisticsScope = useCallback((statisticsScope: AnalyticsScope) => setUiWorkspace((w) => ({ ...w, statisticsScope })), [setUiWorkspace])
  const setJournalScope = useCallback((journalScope: AnalyticsScope) => setUiWorkspace((w) => ({ ...w, journalScope })), [setUiWorkspace])
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

  const changeTimeframe = useCallback((id: number, timeframe: Timeframe) => {
    synchronizer.deactivate()
    setUiWorkspace((w) => ({ ...w,
      timeframes: w.timeframes.map((value, index) => index === id ? timeframe : value),
      indicators: w.indicators.map((settings, index) => index === id && !settings[timeframe]
        ? { ...settings, [timeframe]: indicatorPreset(timeframe) } : settings),
    }))
  }, [synchronizer, setUiWorkspace])
  const changeSettings = useCallback((id: number, next: IndicatorSettings) => {
    synchronizer.deactivate()
    setUiWorkspace((w) => ({ ...w, indicators: w.indicators.map((value, index) => index === id ? { ...value, [w.timeframes[id]]: next } : value) }))
  }, [synchronizer, setUiWorkspace])

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
          {timeframes.slice(0, chartCount).map((timeframe, id) => <ChartPane placement={null} onPick={() => {}} key={id} id={id} timeframe={timeframe}
            sessionId={sessions.activeId} positions={trading.state.positions} stops={stopOverlays(trading.state)} source={history ? historyCandles(history) : EMPTY_CANDLES} count={replay.count} synchronizer={synchronizer} onTimeframeChange={changeTimeframe}
            settings={indicatorSettings[id][timeframe]!} onSettingsChange={changeSettings} />)}
        </div>
        {status === 'loading' && <div className="chart-message" role="status">Loading EURUSD bid/ask history · {loadProgress.completed} / {loadProgress.total} chunks complete…</div>}
        {status === 'error' && <div className="chart-message" role="alert"><p>{error}</p><button type="button" onClick={() => setRequestedRange({ ...requestedRange })}>Retry</button></div>}
        {status === 'ready' && history && startIndex >= historyCandles(history).length && <div className="chart-message" role="status">No bid candles are available at or after the chosen replay start within this trading period.</div>}
      </div>
      <TradingPanel sessionId={sessions.activeId} onConfigureCommission={trading.configureCommission} onConfigure={trading.configure} state={trading.state} permission={trading.permission} onEntry={trading.enter} onCancel={trading.cancel} onClose={trading.close} onModifyStop={trading.modifyStop} />
      <TradingJournal sessionId={sessions.activeId} key={`${sessions.activeId}-${trading.state.session}`} state={trading.state} onUpdateSetup={trading.updateSetup} scope={statisticsScope} view={journalScope} onScopeChange={setStatisticsScope} onViewChange={setJournalScope} />
      <EquityChart sessionId={sessions.activeId} ledger={trading.equity} referenceBalance={trading.state.account.referenceBalance} />
      </fieldset>
      <p className="chart-note">UTC dates · Start inclusive · End exclusive · Up to 365 completed days</p>
    </main>
  )
}
