import { tradeOverlayRecords } from './tradeOverlays'
import { RegressionCalculator } from './regressionChannel'
import { useDismissibleDetails } from './useOutsideInteraction'
import { useReplayKeyboard } from './useReplayKeyboard'
import { useIndicatorKeyboard } from './useIndicatorKeyboard'
import { validUntakenSettings } from './untakenLevels'
import { GLOBAL_UI_ID, readUntakenSettings } from './uiPreferences'
import { entryOverlays } from './entryOverlays'
import { stopOverlays } from './stopOverlays'
import { canRequestOrder, stopModificationError } from './trading'
import { plannedRisk } from './risk'
import type { StopPreview } from './useStopDrag'
import { HistoryTimeline } from './HistoryTimeline'
import { automaticReplayStart, cachedPreset, formatUtcDate, randomCachedRange, rangeCoverage, type CacheCalendar, type WarmupRequirement } from './cacheCalendar'
import { historyCandles, isSinglePrice, isLocalForex, isFuturesHistory } from './history'
import { flushSync } from 'react-dom'
import { ManagementDialog } from './ManagementDialog'
import { ChartPane } from './ChartPane'
import { draftEstimate, draftObservedPrice, TradingDock, type StopDraft } from './TradingDock'
import { accountPnl, selectedRange, shiftDate } from './workflow'
import { lifecycleOf, type Lifecycle } from './sessionTypes'
import { commissionConfigError } from './commissions'
import { defaultWorkspace, readUi, selectChartMode, updateActiveChartMode, useUiValue, validBoolean, validWorkspace, writeUi } from './uiPreferences'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { SessionControls } from './SessionControls'
import { useSessionPersistence } from './useSessionPersistence'
import { equitySummary, type Hydration, type SessionSnapshot, type WorkspaceSettings } from './sessionTypes'
import { ChartSynchronizer } from './chartSync'
import { useReplay } from './useReplay'
import { accountRiskError } from './risk'
import { useTrading } from './useTrading'
import { ResultsDashboard } from './ResultsDashboard'
import { indicatorPreset, indicatorWarmupRequirement, type IndicatorSettings } from './indicators'
import { HistoryLoader, type LoadProgress, type LoadedHistory } from './historyLoader'
import { BACKTEST_DAY_PRESETS, HistoryRequestError, MAX_BACKTEST_DAYS, type Candle, type DateRange, type Timeframe } from './history'

const EMPTY_CANDLES: readonly Candle[] = []
const DEFAULT_RANGE: DateRange = { from: '2024-01-09', to: '2024-01-10' }
function workspaceWarmupRequirements(workspace: WorkspaceSettings): WarmupRequirement[] {
  const byTimeframe = new Map<Timeframe, number>()
  workspace.timeframes.slice(0, workspace.chartCount).forEach((timeframe, index) => {
    const periods = indicatorWarmupRequirement(workspace.indicators[index][timeframe]!)
    if (periods) byTimeframe.set(timeframe, Math.max(periods, byTimeframe.get(timeframe) ?? 0))
  })
  return [...byTimeframe].map(([timeframe, periods]) => ({ timeframe, periods }))
}

export function App() {
  const [from, setFrom] = useState(DEFAULT_RANGE.from)
  const [to, setTo] = useState(DEFAULT_RANGE.to)
  const [requestedRange, setRequestedRange] = useState<DateRange>(DEFAULT_RANGE)
  const [history, setHistory] = useState<LoadedHistory | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [lifecycle, setLifecycle] = useState<Lifecycle>('setup')
  const [stopPreview, setStopPreview] = useState<StopPreview | null>(null)
  const [stopError, setStopError] = useState<string | null>(null)
  const [draft, setDraft] = useState<StopDraft | null>(null)
  const executionDetails = useDismissibleDetails()
  const [activeChart, setActiveChart] = useState(0)
  const [keyboardNotice, setKeyboardNotice] = useState('')
  const [manage, setManage] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [coverageError, setCoverageError] = useState<string | null>(null)
  const [randomError, setRandomError] = useState<string | null>(null)
  const [calendar, setCalendar] = useState<CacheCalendar | null>(null)
  const [endMoved, setEndMoved] = useState(false)
  const selectionTouched = useRef(false)
  const starting = useRef(false)
  const [pendingStart, setPendingStart] = useState(false)
  const loadAbort = useRef<AbortController | null>(null)
  const loadGeneration = useRef(0)
  const [error, setError] = useState<string | null>(null)
  const [, setHistoryFailure] = useState<HistoryRequestError | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [loader] = useState(() => new HistoryLoader())
  const [loadProgress, setLoadProgress] = useState<LoadProgress>({ completed: 0, total: 0 })
  const [hydration, setHydration] = useState<Hydration | null>(null)
  const [regressionAnchor, setRegressionAnchor] = useState<number | null>(null)
  const [loadedRequirements, setLoadedRequirements] = useState<WarmupRequirement[]>(() => workspaceWarmupRequirements(defaultWorkspace()))

  const source = history ? historyCandles(history) : EMPTY_CANDLES
  const tradingFrom = history?.tradingFrom ?? requestedRange.from
  const automaticStart = useMemo(() => history ? automaticReplayStart(source, { from: tradingFrom, to: history.to }, loadedRequirements) : null, [history, source, tradingFrom, loadedRequirements])
  const startMs = hydration?.checkpoint.replay.startTimestamp ?? automaticStart?.timestamp ?? Date.parse(tradingFrom)
  const startIndex = hydration?.checkpoint.replay.startIndex ?? automaticStart?.index ?? source.length
  const replay = useReplay(history ? source : null, startIndex, hydration ? { replay: hydration.checkpoint.replay, epoch: hydration.checkpoint.trading.session } : null)
  const trading = useTrading(history, replay, hydration)
  const stops = useMemo(() => stopOverlays(trading.state, stopPreview), [trading.state, stopPreview])
  const entries = useMemo(() => entryOverlays(trading.state), [trading.state])
  const draftInvalid = replay.reviewing || !draft || !canRequestOrder(trading.permission) || !!draftEstimate(trading.state, draft).error
  const confirmedDraft = useRef<StopDraft | null>(null)
  const confirmDraft = () => {
    if (!draft || draft.price === null || draftInvalid || confirmedDraft.current === draft) return
    confirmedDraft.current = draft
    if (draft.positionId) trading.modifyStop(draft.positionId, draft.price)
    else trading.enterAutomatic(draft.direction, draft.sizing, draft.price)
    setDraft(null)
  }
  const chartOffset = useMemo(() => {
    if (!history || !isFuturesHistory(history) || !history.candles[startIndex]) return 0
    let index = startIndex
    while (index > 0 && history.candles[index - 1].instrumentId === history.candles[startIndex].instrumentId) index--
    return index
  }, [history, startIndex])
  const chartSource = useMemo(() => source.slice(chartOffset), [source, chartOffset])
  const regressionCalculator = useMemo(() => new RegressionCalculator(chartSource), [chartSource])
  const regression = useMemo(() => regressionCalculator.update(regressionAnchor, Math.max(0, replay.displayCount - chartOffset)),
    [regressionCalculator, regressionAnchor, replay.displayCount, chartOffset])
  const bounds = useMemo(() => source.length && replay.count ? {
    from: source[chartOffset].timestamp / 1000,
    to: source[replay.count - 1].timestamp / 1000,
  } : undefined, [history, replay.count, chartOffset])
  const workspace = useMemo<WorkspaceSettings>(() => defaultWorkspace(), [])
  const snapshot = useMemo<SessionSnapshot | null>(() => history ? ({ ledger: trading.equity, checkpoint: {
    lifecycle, replay: { started: replay.active, index: replay.active ? replay.count - 1 : null, timestamp: replay.timestamp,
      startIndex: replay.active ? replay.startIndex : startIndex, startTimestamp: startMs, speed: replay.speed, complete: replay.complete, playing: replay.playing },
    trading: trading.state, executionCursor: trading.executionCursor, equity: equitySummary(trading.equity), workspace, regressionAnchor,
  } }) : null, [lifecycle, history, trading.state, trading.equity, trading.executionCursor, replay.active, replay.count, replay.timestamp, replay.startIndex, replay.speed, replay.complete, replay.playing, startIndex, startMs, workspace, regressionAnchor])
  const sessions = useSessionPersistence({ history, snapshot, actionVersion: trading.actionVersion, pause: replay.pause,
    captureViewport: () => synchronizer.snapshot(),
    download: (range, progress) => new HistoryLoader().load(range, new AbortController().signal, progress ?? setLoadProgress),
    restore: (saved, source) => {
      selectionTouched.current = true
      loadGeneration.current++; loadAbort.current?.abort(); setDraft(null); setManage(false); setLifecycle(lifecycleOf(saved.checkpoint))
      setHydration(saved); setHistory(source); setRequestedRange(saved.record.range)
      setRegressionAnchor(saved.checkpoint.regressionAnchor ?? null)
      setLoadedRequirements(workspaceWarmupRequirements(saved.checkpoint.workspace))
      setFrom(saved.record.range.from); setTo(saved.record.range.to)
      setPendingStart(false); starting.current = false
      setStatus('ready'); setError(null); setFormError(null)
    },
    fresh: (range) => {
      selectionTouched.current = true
      setPendingStart(false); starting.current = false
      loadGeneration.current++; loadAbort.current?.abort(); setDraft(null); setLifecycle('setup'); setStatus('idle'); setManage(false)
      setHydration(null); setHistory(null); setRequestedRange({ ...range }); setFrom(range.from); setTo(range.to)
      setRegressionAnchor(null)
    },
  })

  const [uiWorkspace, setUiWorkspace] = useUiValue(sessions.activeId, 'workspace', hydration?.checkpoint.workspace ?? workspace, validWorkspace)
  const [showExecutions, setShowExecutions] = useUiValue(sessions.activeId, 'executions', false, validBoolean)
  const [showOriginalSl, setShowOriginalSl] = useUiValue(sessions.activeId, 'slHistory', false, validBoolean)
  const [regressionEnabled, setRegressionEnabled] = useUiValue(sessions.activeId, 'regression', false, validBoolean)
  const untakenDefaults = useMemo(readUntakenSettings, [])
  const [untaken, setUntaken] = useUiValue(GLOBAL_UI_ID, 'untakenLevels', untakenDefaults, validUntakenSettings)
  useEffect(() => { writeUi(GLOBAL_UI_ID, 'untakenLevels', { enabled: untaken.enabled, count: untaken.count, pivotStrength: untaken.pivotStrength }) }, [untaken])
  const tradeRecords = useMemo(() => showExecutions || showOriginalSl ? tradeOverlayRecords(trading.state.positions, trading.state.closed) : [], [trading.state.positions, trading.state.closed, showExecutions, showOriginalSl])
  const uiWorkspaceRef = useRef(uiWorkspace)
  useLayoutEffect(() => { uiWorkspaceRef.current = uiWorkspace }, [uiWorkspace])
  const { chartCount, timeframes, indicators: indicatorSettings } = uiWorkspace
  const setChartCount = (chartCount: 1 | 2 | 3 | 4) => setUiWorkspace((w) => selectChartMode(w, chartCount))
  const synchronizer = useMemo(() => {
    const sync = new ChartSynchronizer(bounds)
    sync.restore(readUi(sessions.activeId, 'workspace', hydration?.checkpoint.workspace ?? workspace, validWorkspace).viewport)
    return sync
  }, [history, replay.epoch, sessions.activeId])
  useLayoutEffect(() => {
    synchronizer.onActiveChartChange = setActiveChart
    synchronizer.retainCharts(chartCount)
    setActiveChart(synchronizer.keyboardChartId)
    return () => { synchronizer.onActiveChartChange = undefined }
  }, [synchronizer, chartCount])
  useReplayKeyboard({
    enabled: lifecycle === 'trading' && replay.active,
    playing: replay.playing,
    busy: !!draft || !!stopPreview || manage || finishing || sessions.busy || sessions.conflict || sessions.awaitingChoice || !sessions.initialized,
    onPlaying: () => setKeyboardNotice('Pause replay to use Shift + Arrow or Ctrl + Shift + Arrow keys.'),
    navigate: (direction, timeframe) => replay.navigate(direction, timeframe ?? timeframes[activeChart] ?? timeframes[0], chartOffset),
  })
  useEffect(() => { if (!replay.playing) setKeyboardNotice('') }, [replay.playing])
  useLayoutEffect(() => { synchronizer.advance(bounds) }, [synchronizer, bounds])
  useEffect(() => {
    if (!sessions.activeId) return
    const persist = () => {
      const stored = readUi(sessions.activeId, 'workspace', uiWorkspaceRef.current, validWorkspace)
      const viewport = synchronizer.snapshot()
      if (JSON.stringify(viewport) !== JSON.stringify(stored.viewport)) writeUi(sessions.activeId, 'workspace', { ...stored, viewport })
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    synchronizer.onViewportChange = () => { if (!timer) timer = setTimeout(() => { timer = null; persist(); void sessions.flush().catch(() => {}) }, 250) }
    const scroll = () => writeUi(sessions.activeId, 'scrollY', Math.max(0, Math.min(1000000, window.scrollY)))
    const hidden = () => { persist(); scroll() }
    window.addEventListener('pagehide', hidden); document.addEventListener('visibilitychange', hidden)
    const scrollY = readUi(sessions.activeId, 'scrollY', 0, (v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1000000)
    let frame = 0
    if (scrollY && typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(() => window.scrollTo(0, scrollY))
    return () => { if (timer) clearTimeout(timer); if (frame) cancelAnimationFrame(frame); synchronizer.onViewportChange = undefined; persist(); scroll(); window.removeEventListener('pagehide', hidden); document.removeEventListener('visibilitychange', hidden) }
  }, [sessions.activeId, synchronizer])

  async function refreshCoverage() {
    try {
      const discovery = await fetch('/api/history/datasets')
      if (!discovery.ok) { const body = await discovery.json().catch(() => null); throw new Error(body?.error ?? 'Local history could not be verified.') }
      const installed = await discovery.json()
      if (!Array.isArray(installed.datasets) || !installed.datasets.some((item: { symbol: string; tradingEnabled: boolean }) => item.symbol === 'EURUSD' && item.tradingEnabled)) { setCalendar({days: []}); setCoverageError(null); return }
      const response = await fetch('/api/history/calendar?symbol=EURUSD')
      if (!response.ok) { const body = await response.json().catch(() => null); throw new Error(body?.error ?? 'Local history could not be verified.') }
      const value: CacheCalendar = await response.json()
      if (!Array.isArray(value.days)) throw Error()
      setCalendar(value); setCoverageError(null)
      if (!selectionTouched.current) {
        const requirements = workspaceWarmupRequirements(defaultWorkspace())
        const initial = cachedPreset(value, 90, undefined, requirements) ?? cachedPreset(value, 30, undefined, requirements) ?? cachedPreset(value, 7, undefined, requirements)
        if (initial) { setFrom(initial.from); setTo(initial.to); setRequestedRange(initial) }
      }
    } catch (reason) { setCoverageError(reason instanceof Error && reason.message ? reason.message : 'Local history could not be verified.') }
  }
  useEffect(() => { void refreshCoverage(); return () => { loadAbort.current?.abort(); loadGeneration.current++ } }, [])
  useEffect(() => {
    if (!pendingStart || !history || !automaticStart) return
    // This render has the new dataset and its exact index. The replay closure
    // cannot refer to the previously loaded dataset.
    setPendingStart(false); starting.current = false; setDraft(null); setLifecycle('trading'); replay.start()
  }, [pendingStart, history, automaticStart])
  useEffect(() => { if (replay.playing) setDraft(null) }, [replay.playing])
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setDraft(null) }
    window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape)
  }, [])
  const pickStop = useCallback((price: number) => setDraft(d => d ? { ...d, price } : null), [])
  async function loadData(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    if (starting.current) return
    const selected = selectedRange(from, shiftDate(to, -1), null)
    setFormError(selected.error)
    if (selected.error || accountRiskError(trading.state.account) || commissionConfigError(trading.state.commission)) return
    starting.current = true; selectionTouched.current = true
    const generation = ++loadGeneration.current
    loadAbort.current?.abort()
    const controller = new AbortController(); loadAbort.current = controller
    setStatus('loading'); setError(null); setHistoryFailure(null); setLoadProgress({completed:0,total:1}); setRequestedRange(selected.range)
    try {
      await sessions.flush()
      const coverage = calendar ? rangeCoverage(calendar, selected.range, workspaceWarmupRequirements(uiWorkspace)) : null
      if (coverage?.replayMissing) throw new Error(`${coverage.replayMissing} replay days have missing or unverified local observations. Choose another range.`)
      if (!coverage?.replay || coverage.missing || !coverage.warmupFrom) throw new Error('Insufficient verified history before the replay start for the selected indicators.')
      const requirements = workspaceWarmupRequirements(uiWorkspace)
      const result = await loader.load(selected.range, controller.signal, setLoadProgress, coverage.warmupFrom)
      if (generation !== loadGeneration.current) return
      if (!automaticReplayStart(historyCandles(result), selected.range, requirements)) throw new Error('Insufficient completed historical candles for the selected indicators. Select a later replay start.')
      const chosenName = sessions.name
      if (history && !await sessions.fresh(selected.range)) throw new Error('The previous backtest could not be saved. Local history is ready; retry storage before switching.')
      starting.current = true
      // Name updates flush persistence immediately, so install the new history first.
      flushSync(() => { setLoadedRequirements(requirements); setHydration(null); setRegressionAnchor(null); setHistory(result); setStatus('ready'); setPendingStart(true) })
      sessions.editName(chosenName); void refreshCoverage()
    } catch (reason) {
      if (generation !== loadGeneration.current || controller.signal.aborted) return
      setHistoryFailure(reason instanceof HistoryRequestError ? reason : null)
      setError(reason instanceof Error ? reason.message : 'Historical data unavailable.'); setStatus('error'); starting.current = false; void refreshCoverage()
    }
  }
  async function finish() {
    flushSync(() => { replay.pause(); setDraft(null); setFinishing(true) })
    try {
      await sessions.flush()
      if (!window.confirm(`Finish this backtest? ${trading.state.positions.length} open positions, ${trading.state.pending.length} pending entries and ${trading.state.positions.filter(p=>p.closeRequestedAt !== null).length} pending closes remain. No exits will be created. Results include unrealized account PnL separately from realized statistics.`)) return
      flushSync(() => { setLifecycle('finished') })
      await sessions.flush()
    } catch { setLifecycle('trading') }
    finally { setFinishing(false) }
  }

  async function resumeBacktest() {
    if (lifecycle !== 'finished' || finishing || sessions.busy || sessions.conflict || sessions.awaitingChoice || !sessions.initialized || sessions.saveStatus === 'Saving') return
    flushSync(() => { replay.pause(); setFinishing(true) })
    try {
      await sessions.flush()
      // Keep the replay/trading hooks and synchronizer intact. Only the saved
      // workspace lifecycle changes; no replay start or next-candle action.
      flushSync(() => { setLifecycle('trading') })
      await sessions.flush()
    } catch { flushSync(() => { setLifecycle('finished') }) }
    finally { setFinishing(false) }
  }

  function restart() {
    const valuable = trading.state.setups.length > 0 || trading.state.closed.length > 0 || trading.state.positions.length > 0 || trading.state.pending.length > 0
    if (valuable && !window.confirm('Restart this session? Trading records, journal notes and replay progress will be cleared and overwritten in autosaves. Cancel and choose New session to keep this backtest separately.')) return
    setDraft(null); setHydration(null)
    replay.restart()
  }

  const changeTimeframe = useCallback((id: number, timeframe: Timeframe) => {
    synchronizer.deactivate()
    setUiWorkspace((w) => updateActiveChartMode(w, {
      timeframes: w.timeframes.map((value, index) => index === id ? timeframe : value),
      indicators: w.indicators.map((settings, index) => index === id && !settings[timeframe]
        ? { ...settings, [timeframe]: indicatorPreset(timeframe) } : settings),
    }))
  }, [synchronizer, setUiWorkspace])
  const changeSettings = useCallback((id: number, next: IndicatorSettings) => {
    synchronizer.deactivate()
    setUiWorkspace((w) => updateActiveChartMode(w, { timeframes: w.timeframes,
      indicators: w.indicators.map((value, index) => index === id ? { ...value, [w.timeframes[id]]: next } : value) }))
  }, [synchronizer, setUiWorkspace])

  const pnl = accountPnl(trading.equity, trading.state.account.referenceBalance)
  const selected = selectedRange(from, shiftDate(to, -1), null)
  const warmupRequirements = useMemo(()=>workspaceWarmupRequirements(uiWorkspace),[uiWorkspace])
  const clearSelectionErrors = () => { setFormError(null); setError(null); setRandomError(null) }
  const firstCalendarDate = calendar?.days[0]?.date
  const dateFields = <div className="period-fields"><label>From<input aria-label="From" type="date" min={firstCalendarDate} max={calendar?.lastTimestamp ? new Date(calendar.lastTimestamp).toISOString().slice(0,10) : undefined} value={from} disabled={status === 'loading'} onChange={e=>{selectionTouched.current=true;setFrom(e.target.value);clearSelectionErrors()}}/></label><label>Through<input aria-label="Through" type="date" min={firstCalendarDate} max={calendar?.lastTimestamp ? new Date(calendar.lastTimestamp).toISOString().slice(0,10) : undefined} value={shiftDate(to,-1)} disabled={status === 'loading'} onChange={e=>{selectionTouched.current=true;setEndMoved(true);setTo(shiftDate(e.target.value,1));clearSelectionErrors()}}/></label></div>
  const readiness = useMemo(()=>calendar && !selected.error ? rangeCoverage(calendar,{from,to},warmupRequirements) : null,[calendar,from,to,selected.error,warmupRequirements])
  const presets = useMemo(()=>BACKTEST_DAY_PRESETS.map(days=>calendar ? cachedPreset(calendar,days,endMoved ? to : undefined,warmupRequirements) : null),[calendar,endMoved,to,warmupRequirements])
  const chartLayout = <fieldset className="layout-controls"><legend>Charts</legend>{([1,2,3,4] as const).map(count=><label key={count}><input type="radio" name="chart-count" value={count} checked={chartCount === count} onChange={()=>{ synchronizer.deactivate(); setChartCount(count) }}/>{count}</label>)}</fieldset>
  const pnlDisplay = <div className={`account-pnl ${pnl && Math.abs(pnl.usd) >= 0.005 ? pnl.usd > 0 ? 'positive' : 'negative' : ''}`} aria-label="Account PnL"><span>Account PnL</span><strong>{pnl ? `$${pnl.usd.toFixed(2)} · ${pnl.percent.toFixed(2)}%` : 'PnL unavailable'}</strong></div>
  const workspaceDisabled = !sessions.initialized || sessions.busy || sessions.conflict || sessions.awaitingChoice || finishing
  useIndicatorKeyboard({
    blocked: lifecycle !== 'trading' || workspaceDisabled || manage || !!draft || !!stopPreview,
    toggleUntaken: () => setUntaken(value => ({ ...value, enabled: !value.enabled })),
    toggleIchimoku: () => {
      const settings = indicatorSettings[activeChart][timeframes[activeChart]]!
      changeSettings(activeChart, { ...settings, ichimoku: { ...settings.ichimoku, enabled: !settings.ichimoku.enabled } })
    },
  })
  return <main className={`app-shell phase-${lifecycle}`}>
    <header className="app-header"><h1>ForexTester</h1><span className="header-session"><span className="session-name">{sessions.name}</span> <span className="save-state">{history ? sessions.saveStatus : 'Not started'}</span></span>
      {lifecycle === 'trading' && <details ref={executionDetails} className="execution-details"><summary aria-label="Execution details" title="Execution details"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v2"/></svg></summary><div className="execution-popover">
        <strong>Execution details</strong>
        <p>While paused: Shift + Left/Right navigates the focused chart’s timeframe. Ctrl + Shift + Left/Right navigates one available M1 observation, independent of the focused timeframe. Backward navigation is historical review only and does not rewind trade execution. Select a chart by clicking, panning, scrolling or changing its timeframe. Return to current replay to trade.</p>
        {history && isLocalForex(history) ? <p>EURUSD mid prices · simplified single-price execution. 1 standard lot = 100,000 EUR; PnL is in USD. No spread, bid/ask, tick sequence, slippage, swaps or financing are modeled. Entries and manual exits use the next observed M1 open; stops use M1 high/low and gap opens.</p> : history && isFuturesHistory(history) ? <p>6E trade prices · hypothetical forex-style sizing (1 lot = 100,000 EUR). No spread; entries fill at the next eligible M1 opening, with high/low stops and gap-open handling. Not exchange-accurate futures or EUR/USD CFD execution.</p> : <p>Original legacy bid/ask execution. Entries fill at the next synchronized M1 opening.</p>}
        <p>SL amounts are net at the stop level, including entry and exit commissions. Pending values estimate the next fill from the observed price. Gaps can change the outcome. Entry lines mark the fill price; net breakeven also includes commissions.</p>
        {history && isFuturesHistory(history) && <details><summary>Contract mappings and rollover events</summary>{history.contracts.map(c=><p key={c.from}>{c.from} to {c.to} (exclusive): {c.rawSymbol} · instrument {c.instrumentId}</p>)}</details>}
      </div></details>}
      {lifecycle === 'trading' && (
        <fieldset className="header-replay" aria-label="Market replay" disabled={workspaceDisabled || status === 'loading' || pendingStart || manage || !!stopPreview} hidden={!sessions.initialized || sessions.awaitingChoice}>
          <button disabled={!replay.canPlay || !!stopPreview} onClick={()=>{setDraft(null);replay.play()}}>Play</button><button disabled={!replay.canPause} onClick={replay.pause}>Pause</button><button disabled={!replay.canNext || !!stopPreview} onClick={()=>{setDraft(null);replay.next()}}>Next Min</button>
          <label>Speed<select aria-label="Replay speed" value={replay.speed} onChange={e=>replay.setSpeed(Number(e.target.value) as 1|10|100)}>{[1,10,100].map(s=><option key={s} value={s}>{s}×</option>)}</select></label>
          {chartLayout}<div className="overlay-toggles"><button aria-pressed={showExecutions} onClick={()=>setShowExecutions(value=>!value)}>Executions</button><button aria-pressed={showOriginalSl} onClick={()=>setShowOriginalSl(value=>!value)}>Original SL</button><button aria-pressed={regressionEnabled} title="Ctrl + Click a candle to anchor the M1 regression channel" onClick={()=>setRegressionEnabled(value=>!value)}>Regression</button></div><div className="replay-state"><span aria-label="Replay status" className="replay-status">{replay.status}</span><span className="replay-progress" aria-label="Replay progress">{replay.revealed-replay.startIndex} / {replay.total-replay.startIndex} candles</span></div><button disabled={replay.reviewing} onClick={()=>void finish()}>{replay.complete || replay.blocked ? 'Review Results' : 'Finish backtest'}</button>
        </fieldset>
      )}
      {lifecycle !== 'setup' && <div className="header-account"><time className="replay-clock">{replay.timestamp === null ? 'Awaiting replay' : new Date(replay.timestamp).toISOString().slice(0,16).replace('T',' ') + ' UTC'}</time>{pnlDisplay}</div>}<button onClick={()=>{ replay.pause(); setDraft(null); setManage(true) }}>Sessions / settings</button>
    </header>
    {sessions.error && !manage && !sessions.awaitingChoice && <p className="form-error critical-save" role="alert">{sessions.error} <button onClick={()=>setManage(true)}>Open storage controls</button></p>}
    {sessions.awaitingChoice && !manage && <section className="startup-selection" aria-label="Choose a backtest"><SessionControls startup sessions={sessions} range={{from:tradingFrom,to:history?.to ?? requestedRange.to}} timestamp={replay.timestamp}/></section>}
    {manage && <ManagementDialog required={false} busy={sessions.busy || finishing} onClose={()=>setManage(false)}>
      <button className="close-management" disabled={sessions.busy || finishing} onClick={()=>setManage(false)}>Close management</button>
      <SessionControls sessions={sessions} range={{from:tradingFrom,to:history?.to ?? requestedRange.to}} timestamp={replay.timestamp}/>
      {lifecycle === 'trading' && <button disabled={sessions.busy || finishing} onClick={()=>{ restart(); setManage(false) }}>Restart backtest</button>}
    </ManagementDialog>}
    {!sessions.initialized && !sessions.awaitingChoice && <p className="startup-status" role="status">Checking saved backtests…</p>}
    <fieldset className="workspace-controls" disabled={workspaceDisabled} hidden={!sessions.initialized || sessions.awaitingChoice}>
      {lifecycle === 'setup' && <section className="setup-workspace" aria-label="Backtest setup">
        <div className="setup-heading"><h2>Set up a backtest</h2><p>Choose local Forex history and start a paused, indicator-ready replay.</p></div>
        {!!sessions.legacySessions.length && <p className="chart-note">Older browser backtests are available. <button type="button" onClick={()=>setManage(true)}>Review browser backtests</button></p>}
        <form onSubmit={loadData} className="setup-form" id="setup-form">
          <section className="historical-period"><h3>Historical period <span>EURUSD · Mid · M1 · UTC</span></h3><p className="chart-note">Mid-price M1 candles. Simplified fills with no spread, slippage or financing.</p>
            {calendar?.days.length ? <HistoryTimeline calendar={calendar} range={{from,to}} warmupFrom={readiness?.warmupFrom ?? undefined} disabled={status === 'loading'} onEndChange={()=>setEndMoved(true)} onChange={range=>{selectionTouched.current=true;setFrom(range.from);setTo(range.to);clearSelectionErrors()}}/> : <p role="status">{coverageError ? coverageError : calendar ? 'No local EURUSD history is installed. Import the archive with the local import command to begin.' : 'Checking local history…'} {coverageError && <button type="button" onClick={()=>void refreshCoverage()}>Retry coverage</button>}</p>}
            <div className="period-shortcuts">{BACKTEST_DAY_PRESETS.map((days,index)=><button type="button" key={days} disabled={status === 'loading' || !calendar || !presets[index]} aria-pressed={selected.days === days} onClick={()=>{const range=presets[index];if(range){selectionTouched.current=true;setFrom(range.from);setTo(range.to);clearSelectionErrors()}}}>{days} days</button>)}<button type="button" disabled={status === 'loading' || !calendar} onClick={()=>{if(!calendar)return;const range=randomCachedRange(calendar,Math.random,warmupRequirements);if(!range){setRandomError('No cached 120-day replay window has verified replay data and enough preceding history for the selected indicators.');return}selectionTouched.current=true;setEndMoved(false);setFrom(range.from);setTo(range.to);clearSelectionErrors()}}>Random Range</button><span>{Number.isFinite(selected.days) ? selected.days : 0} calendar days · maximum {MAX_BACKTEST_DAYS}</span></div>
            <div className="period-readiness" role="status">{randomError && <p className="form-error">{randomError}</p>}{calendar && (()=>{
              if (selected.error) return <p className="form-error">Choose 1 to {MAX_BACKTEST_DAYS} completed UTC calendar days.</p>
              if (!readiness) return null
              return <><p><strong>{readiness.replayMissing ? `${readiness.replayMissing} replay days have missing or unverified local observations. Choose another range.` : readiness.warmupMissing ? `${readiness.warmupMissing} indicator warm-up days have missing or unverified local observations.` : `${selected.days} days selected · available locally.`}</strong></p>
                {!readiness.missing && readiness.warmupFrom && !!readiness.replay?.required && <p>Replay is {selected.days} days. Indicator warm-up is separate, from {formatUtcDate(readiness.warmupFrom)}. Market closures remain gaps.</p>}
                {readiness.replay && <><p>Replay begins automatically: <strong>{formatUtcDate(readiness.replay.timestamp)}, {new Date(readiness.replay.timestamp).toISOString().slice(11,16)} UTC</strong></p>{readiness.replay.required ? <p>{readiness.replay.count} completed {readiness.replay.timeframe} candles available · {readiness.replay.required} required by the longest indicator warm-up.</p> : <p>No indicator warm-up required. History begins with the selected replay period.</p>}{readiness.replay.timestamp > Date.parse(from) && <p className="coverage-warning">The first tradable minute is later than your From date because of a market closure or missing observation.</p>}</>}
                {!readiness.missing && !readiness.replay && <p className="form-error">Insufficient completed historical candles before the replay start for the selected indicators.</p>}
              </>
            })()}</div>
          </section>
          <section className="setup-account"><h3>Backtest details <span>USD account</span></h3><div className="account-fields">
            <label>Backtest name<input maxLength={200} aria-label="Backtest name" disabled={status === 'loading'} value={sessions.name} onChange={e=>sessions.editName(e.target.value)}/></label>
            <label>Round-trip commission ($ / standard lot)<input aria-label="Round-trip commission (USD per standard lot)" type="number" min="0" step="any" disabled={status === 'loading'} value={trading.state.commission.roundTripUsdPerLot} onChange={e=>{const value={roundTripUsdPerLot:Number(e.target.value)};setFormError(commissionConfigError(value));trading.configureCommission(value)}}/></label>
            <label>Starting balance (USD)<input aria-label="Starting balance (USD)" type="number" min="0" step="any" disabled={status === 'loading'} value={trading.state.account.referenceBalance || ''} onChange={e=>trading.configure({...trading.state.account,referenceBalance:Number(e.target.value)})}/></label>
            <label>Maximum combined gross risk (%)<input aria-label="Maximum combined gross planned risk (%)" type="number" min="0" max="100" step="any" disabled={status === 'loading'} value={trading.state.account.maxRiskPercent || ''} onChange={e=>trading.configure({...trading.state.account,maxRiskPercent:Number(e.target.value)})}/></label>
          </div></section>
          <details className="setup-advanced"><summary>Advanced settings</summary><div className="advanced-fields">
            <div className="initial-layout">{chartLayout}</div>
            <div><h4>Manual historical dates</h4>{dateFields}</div>
            <p className="chart-note">Observation-derived indicator warm-up · EURUSD Forex · local Parquet archive · mid-price M1 candles. Simplified single-price fills with no spread, slippage, swaps or financing. 1 standard lot = 100,000 EUR. Commission is split between entry and exit.</p>
          </div></details>
        </form>
          <footer className="setup-footer"><div aria-live="polite">
            {(formError || accountRiskError(trading.state.account) || commissionConfigError(trading.state.commission)) && <p className="form-error">{formError || accountRiskError(trading.state.account) || commissionConfigError(trading.state.commission)}</p>}
            {status === 'loading' && <div role="status"><p>Preparing charts and indicators…</p>{<button type="button" onClick={()=>{loadGeneration.current++;loadAbort.current?.abort();starting.current=false;setPendingStart(false);setStatus('idle')}}>Cancel loading</button>}<progress max={loadProgress.total || 1} value={loadProgress.completed}/></div>}
            {status === 'error' && <p className="form-error" role="alert">{error}</p>}
          </div><button type="submit" form="setup-form" className="primary-action" disabled={status === 'loading' || !!selected.error || !!accountRiskError(trading.state.account) || !!commissionConfigError(trading.state.commission) || !readiness || !!readiness.missing || !readiness.replay}>Start backtest</button></footer>
      </section>}
      {lifecycle === 'trading' && <>
        <div className="workspace-toolbar" role="region" aria-label="Trading workspace controls">
        <TradingDock reviewing={replay.reviewing} shortcutsBlocked={lifecycle !== 'trading' || workspaceDisabled || manage || !!stopPreview || status !== 'ready' || pendingStart || replay.playing} stops={stops} key={`${sessions.activeId}-${trading.state.session}`} trading={trading} draft={draft} setDraft={setDraft} onConfirm={confirmDraft}/>
        </div>
        {replay.reviewing && <div className="history-review" role="status"><strong>Reviewing history</strong><span>{new Date(replay.reviewTimestamp!).toISOString().slice(0,16).replace('T',' ')} UTC · Trading disabled</span><button onClick={replay.returnToCurrent}>Return to current replay</button></div>}
        {keyboardNotice && <p className="keyboard-notice" role="status">{keyboardNotice}</p>}
        {replay.blocked && <p className="coverage-warning" role="alert">Replay blocked at contract rollover. No positions, stops or pending orders were executed across the boundary. Finish this backtest or select a replay start after the rollover. A carry/roll policy requires project-lead approval.</p>}
        <div className="chart-workspace" aria-label={`${history?.symbol === '6E' ? 'EURUSD 6E' : history?.symbol ?? 'EURUSD'} chart workspace`}><div className={`chart-stack charts-${chartCount}`}>
          {timeframes.slice(0,chartCount).map((timeframe,id)=><ChartPane untaken={untaken} onUntakenChange={setUntaken} regression={regression} regressionEnabled={regressionEnabled && !workspaceDisabled} onRegressionAnchor={setRegressionAnchor} tradeRecords={tradeRecords} showExecutions={showExecutions} showOriginalSl={showOriginalSl} key={id} measurementLayout={chartCount} pipSize={history && isLocalForex(history) ? history.instrument.pipSize : 0.0001} instrument={history?.symbol ?? 'EURUSD'} priceLabel={history && isLocalForex(history) ? 'Mid' : undefined} id={id} active={id === activeChart} reviewing={replay.reviewing} timeframe={timeframe} sessionId={sessions.activeId} positions={replay.reviewing ? [] : trading.state.positions} entries={replay.reviewing ? [] : entries} stops={replay.reviewing ? [] : stops} stopInteraction={{ enabled: canRequestOrder(trading.permission) && !draft,
            preview: stopPreview, onPreview: setStopPreview, onCommit: (positionId, price) => {
              const position = trading.state.positions.find(p => p.id === positionId)
              const error = position ? stopModificationError(trading.state, position, price, trading.permission) : 'Position is no longer open.'
              setStopError(error)
              if (!error) trading.modifyStop(positionId, price)
              return error
            } }} source={chartSource} count={Math.max(0, replay.displayCount - chartOffset)} synchronizer={synchronizer} onTimeframeChange={changeTimeframe} settings={indicatorSettings[id][timeframe]!} onSettingsChange={changeSettings} placement={draft} draftReference={draft ? draftObservedPrice(trading.state, draft) : null} onPick={pickStop}/>)}</div></div>
        {stopPreview && (() => {
          const position = trading.state.positions.find(p => p.id === stopPreview.id)
          const error = position ? stopModificationError(trading.state, position, stopPreview.price, trading.permission) : 'Position is no longer open.'
          return <p className={`stop-drag-status${error ? ' form-error' : ''}`} role="status">{stopPreview.id} · SL {stopPreview.price.toFixed(5)} · {error ?? `Risk $${plannedRisk({ ...position!, stopPrice: stopPreview.price }).toFixed(2)} · Effective after the current M1 candle. Release to apply; Escape to cancel.`}</p>
        })()}
        {stopError && <p className="stop-drag-status form-error" role="alert">{stopError}<button onClick={() => setStopError(null)}>Dismiss</button></p>}
      </>}
      {lifecycle === 'finished' && <ResultsDashboard key={`${sessions.activeId}-${trading.state.session}`} state={trading.state} ledger={trading.equity}
        start={startMs} endpoint={replay.timestamp} singlePrice={!!history && isSinglePrice(history)} onSave={sessions.save}
        onResume={()=>void resumeBacktest()} reviewOnly={replay.complete || replay.blocked} resumeDisabled={workspaceDisabled || manage || sessions.saveStatus === 'Saving'} />}
    </fieldset>
  </main>
}
