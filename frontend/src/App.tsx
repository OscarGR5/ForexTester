import { useDismissibleDetails } from './useOutsideInteraction'
import { useReplayKeyboard } from './useReplayKeyboard'
import { entryOverlays } from './entryOverlays'
import { stopOverlays } from './stopOverlays'
import { canRequestOrder, stopModificationError } from './trading'
import { plannedRisk } from './risk'
import type { StopPreview } from './useStopDrag'
import { HistoryTimeline } from './HistoryTimeline'
import { automaticReplayStart, cachedPreset, formatUtcDate, rangeCoverage, type CacheCalendar } from './cacheCalendar'
import { quoteHistory, downloadHistory, type HistoryQuote } from './databentoHistory'
import { historyCandles, isSinglePrice } from './history'
import { flushSync } from 'react-dom'
import { PaidDownloadDialog } from './PaidDownloadDialog'
import { ManagementDialog } from './ManagementDialog'
import { ChartPane } from './ChartPane'
import { draftEstimate, draftObservedPrice, TradingDock, type StopDraft } from './TradingDock'
import { accountPnl, selectedRange, shiftDate } from './workflow'
import { lifecycleOf, type Lifecycle } from './sessionTypes'
import { commissionConfigError } from './commissions'
import { defaultWorkspace, readUi, useUiValue, validWorkspace, writeUi } from './uiPreferences'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { SessionControls } from './SessionControls'
import { useSessionPersistence } from './useSessionPersistence'
import { equitySummary, type Hydration, type SessionSnapshot, type WorkspaceSettings } from './sessionTypes'
import { ChartSynchronizer } from './chartSync'
import { useReplay } from './useReplay'
import { accountRiskError } from './risk'
import { useTrading } from './useTrading'
import { ResultsDashboard } from './ResultsDashboard'
import { indicatorPreset, type IndicatorSettings } from './indicators'
import { HistoryLoader, type LoadProgress, type LoadedHistory } from './historyLoader'
import { HistoryRequestError, type Candle, type DateRange, type Timeframe } from './history'

const EMPTY_CANDLES: readonly Candle[] = []
const DEFAULT_RANGE: DateRange = { from: '2024-01-09', to: '2024-01-10' }

export function App() {
  const [from, setFrom] = useState(DEFAULT_RANGE.from)
  const [to, setTo] = useState(DEFAULT_RANGE.to)
  const [requestedRange, setRequestedRange] = useState<DateRange>(DEFAULT_RANGE)
  const [quote, setQuote] = useState<HistoryQuote | null>(null)
  const [confirming, setConfirming] = useState(false)
  const paidSubmitting = useRef(false)
  const [paidPending, setPaidPending] = useState(false)
  const [downloadNotice, setDownloadNotice] = useState<string | null>(null)
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
  const [coverageError, setCoverageError] = useState(false)
  const [calendar, setCalendar] = useState<CacheCalendar | null>(null)
  const [endMoved, setEndMoved] = useState(false)
  const selectionTouched = useRef(false)
  const starting = useRef(false)
  const [pendingStart, setPendingStart] = useState(false)
  const [moreData, setMoreData] = useState(false)
  const loadAbort = useRef<AbortController | null>(null)
  const loadGeneration = useRef(0)
  const [error, setError] = useState<string | null>(null)
  const [, setHistoryFailure] = useState<HistoryRequestError | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [loader] = useState(() => new HistoryLoader())
  const [loadProgress, setLoadProgress] = useState<LoadProgress>({ completed: 0, total: 0 })
  const [hydration, setHydration] = useState<Hydration | null>(null)

  const source = history ? historyCandles(history) : EMPTY_CANDLES
  const tradingFrom = history?.tradingFrom ?? requestedRange.from
  const automaticStart = useMemo(() => history ? automaticReplayStart(source, { from: tradingFrom, to: history.to }) : null, [history, source, tradingFrom])
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
    if (!history || !isSinglePrice(history) || !history.candles[startIndex]) return 0
    let index = startIndex
    while (index > 0 && history.candles[index - 1].instrumentId === history.candles[startIndex].instrumentId) index--
    return index
  }, [history, startIndex])
  const chartSource = useMemo(() => source.slice(chartOffset), [source, chartOffset])
  const bounds = useMemo(() => source.length && replay.count ? {
    from: source[chartOffset].timestamp / 1000,
    to: source[replay.count - 1].timestamp / 1000,
  } : undefined, [history, replay.count, chartOffset])
  const workspace = useMemo<WorkspaceSettings>(() => defaultWorkspace(), [])
  const snapshot = useMemo<SessionSnapshot | null>(() => history ? ({ ledger: trading.equity, checkpoint: {
    lifecycle, replay: { started: replay.active, index: replay.active ? replay.count - 1 : null, timestamp: replay.timestamp,
      startIndex: replay.active ? replay.startIndex : startIndex, startTimestamp: startMs, speed: replay.speed, complete: replay.complete, playing: replay.playing },
    trading: trading.state, executionCursor: trading.executionCursor, equity: equitySummary(trading.equity), workspace,
  } }) : null, [lifecycle, history, trading.state, trading.equity, trading.executionCursor, replay.active, replay.count, replay.timestamp, replay.startIndex, replay.speed, replay.complete, replay.playing, startIndex, startMs, workspace])
  const sessions = useSessionPersistence({ history, snapshot, actionVersion: trading.actionVersion, pause: replay.pause,
    captureViewport: () => synchronizer.snapshot(),
    download: (range, progress) => new HistoryLoader().load(range, new AbortController().signal, progress ?? setLoadProgress),
    restore: (saved, source) => {
      selectionTouched.current = true
      loadGeneration.current++; loadAbort.current?.abort(); setDraft(null); setManage(false); setLifecycle(lifecycleOf(saved.checkpoint))
      setHydration(saved); setHistory(source); setRequestedRange(saved.record.range)
      setFrom(saved.record.range.from); setTo(saved.record.range.to)
      setPendingStart(false); starting.current = false
      setStatus('ready'); setError(null); setFormError(null); setQuote(null); setConfirming(false)
    },
    fresh: (range) => {
      selectionTouched.current = true
      setPendingStart(false); starting.current = false
      loadGeneration.current++; loadAbort.current?.abort(); setDraft(null); setLifecycle('setup'); setStatus('idle'); setManage(false)
      setQuote(null); setConfirming(false); setHydration(null); setHistory(null); setRequestedRange({ ...range }); setFrom(range.from); setTo(range.to)
    },
  })

  const [uiWorkspace, setUiWorkspace] = useUiValue(sessions.activeId, 'workspace', hydration?.checkpoint.workspace ?? workspace, validWorkspace)
  const uiWorkspaceRef = useRef(uiWorkspace)
  useLayoutEffect(() => { uiWorkspaceRef.current = uiWorkspace }, [uiWorkspace])
  const { chartCount, timeframes, indicators: indicatorSettings } = uiWorkspace
  const setChartCount = (chartCount: number) => setUiWorkspace((w) => ({ ...w, chartCount }))
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
    onPlaying: () => setKeyboardNotice('Pause replay to use Shift + Arrow keys.'),
    navigate: direction => { setKeyboardNotice(''); return replay.navigate(direction, timeframes[activeChart] ?? timeframes[0], chartOffset) },
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
      const response = await fetch('/api/history/calendar')
      if (!response.ok) throw Error()
      const value: CacheCalendar = await response.json()
      if (!Array.isArray(value.days)) throw Error()
      setCalendar(value); setCoverageError(false)
      if (!selectionTouched.current) {
        const initial = cachedPreset(value, 90) ?? cachedPreset(value, 30) ?? cachedPreset(value, 7)
        if (initial) { setFrom(initial.from); setTo(initial.to); setRequestedRange(initial) }
      }
    } catch { setCoverageError(true) }
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
  useEffect(() => { setQuote(null); setConfirming(false) }, [from, to])
  const pickStop = useCallback((price: number) => setDraft(d => d ? { ...d, price } : null), [])
  async function loadData(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    if (starting.current || paidSubmitting.current) return
    const selected = selectedRange(from, shiftDate(to, -1), null)
    setFormError(selected.error)
    if (selected.error || accountRiskError(trading.state.account) || commissionConfigError(trading.state.commission)) return
    starting.current = true; selectionTouched.current = true
    setQuote(null); setConfirming(false); setDownloadNotice(null)
    const generation = ++loadGeneration.current
    loadAbort.current?.abort()
    const controller = new AbortController(); loadAbort.current = controller
    setStatus('loading'); setError(null); setHistoryFailure(null); setLoadProgress({completed:0,total:1}); setRequestedRange(selected.range)
    try {
      await sessions.flush()
      const estimate = await quoteHistory(selected.range, controller.signal)
      if (generation !== loadGeneration.current) return
      setQuote(estimate)
      if (!estimate.cached) { starting.current = false; setStatus('idle'); setConfirming(true); return }
      const result = await loader.load(selected.range, controller.signal, setLoadProgress)
      if (generation !== loadGeneration.current) return
      if (!automaticReplayStart(historyCandles(result), selected.range)) throw new Error('Insufficient historical candles for Ichimoku. Select a later starting period or a longer interval.')
      const chosenName = sessions.name
      if (history && !await sessions.fresh(selected.range)) throw new Error('The previous backtest could not be saved. New data remains cached; retry storage before switching.')
      starting.current = true
      // Name updates flush persistence immediately, so install the new history first.
      flushSync(() => { setHydration(null); setHistory(result); setStatus('ready'); setPendingStart(true) })
      sessions.editName(chosenName); void refreshCoverage()
    } catch (reason) {
      if (generation !== loadGeneration.current || controller.signal.aborted) return
      setHistoryFailure(reason instanceof HistoryRequestError ? reason : null)
      setError(reason instanceof Error ? reason.message : 'Historical data unavailable.'); setStatus('error'); starting.current = false; void refreshCoverage()
    }
  }
  async function confirmDownload() {
    if (!quote || quote.tradingFrom !== from || quote.to !== to || !quote.downloadAllowed || Date.now() >= Date.parse(quote.expiresAt) || paidSubmitting.current) return
    starting.current = true; paidSubmitting.current = true; setPaidPending(true); setConfirming(false); setDownloadNotice(null)
    const generation = ++loadGeneration.current
    const controller = new AbortController(); loadAbort.current = controller
    setStatus('loading'); setError(null); setHistoryFailure(null); setLoadProgress({ completed: 0, total: 1 })
    try {
      await sessions.flush()
      if (Date.now() >= Date.parse(quote.expiresAt)) throw new Error('Quote expired. Load historical data again for a fresh estimate.')
      const result = await downloadHistory(quote, controller.signal)
      if (generation !== loadGeneration.current) return
      if (!automaticReplayStart(historyCandles(result), { from: quote.tradingFrom, to: quote.to })) throw new Error('Insufficient historical candles for Ichimoku. Select a later starting period or a longer interval.')
      const chosenName = sessions.name
      if (history && !await sessions.fresh({ from: quote.tradingFrom, to: quote.to })) throw new Error('The previous backtest could not be saved. Downloaded data remains cached; retry storage before switching.')
      starting.current = true
      flushSync(() => { setHydration(null); setHistory(result); setStatus('ready'); setPendingStart(true); setLoadProgress({ completed: 1, total: 1 }); setQuote(null) })
      sessions.editName(chosenName)
    } catch (reason) {
      if (generation !== loadGeneration.current || controller.signal.aborted) return
      setHistoryFailure(reason instanceof HistoryRequestError ? reason : null)
      setError(reason instanceof Error ? reason.message : 'Historical download failed.'); setStatus('error'); setQuote(null)
      setDownloadNotice('A paid submission may already have reached the backend. Closing this page does not guarantee no charge. Wait for the backend to finish, then load again to inspect the cache; no request is retried automatically.')
    } finally { starting.current = false; paidSubmitting.current = false; setPaidPending(false) }
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

  function restart() {
    const valuable = trading.state.setups.length > 0 || trading.state.closed.length > 0 || trading.state.positions.length > 0 || trading.state.pending.length > 0
    if (valuable && !window.confirm('Restart this session? Trading records, journal notes and replay progress will be cleared and overwritten in autosaves. Cancel and choose New session to keep this backtest separately.')) return
    setDraft(null); setHydration(null)
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

  const pnl = accountPnl(trading.equity, trading.state.account.referenceBalance)
  const selected = selectedRange(from, shiftDate(to, -1), null)
  const dateFields = <div className="period-fields"><label>From<input aria-label="From" type="date" value={from} disabled={status === 'loading'} onChange={e=>{selectionTouched.current=true;setFrom(e.target.value);setFormError(null)}}/></label><label>Through<input aria-label="Through" type="date" value={shiftDate(to,-1)} disabled={status === 'loading'} onChange={e=>{selectionTouched.current=true;setEndMoved(true);setTo(shiftDate(e.target.value,1));setFormError(null)}}/></label></div>
  const readiness = useMemo(()=>calendar && !selected.error ? rangeCoverage(calendar,{from,to}) : null,[calendar,from,to,selected.error])
  const presets = useMemo(()=>[7,30,90].map(days=>calendar ? cachedPreset(calendar,days,endMoved ? to : undefined) : null),[calendar,endMoved,to])
  const chartLayout = <fieldset className="layout-controls"><legend>Charts</legend>{[1,2,3].map(count=><label key={count}><input type="radio" name="chart-count" value={count} checked={chartCount === count} onChange={()=>{ synchronizer.deactivate(); setChartCount(count) }}/>{count}</label>)}</fieldset>
  const pnlDisplay = <div className={`account-pnl ${pnl && Math.abs(pnl.usd) >= 0.005 ? pnl.usd > 0 ? 'positive' : 'negative' : ''}`} aria-label="Account PnL"><span>Account PnL</span><strong>{pnl ? `$${pnl.usd.toFixed(2)} · ${pnl.percent.toFixed(2)}%` : 'PnL unavailable'}</strong></div>
  const workspaceDisabled = !sessions.initialized || sessions.busy || sessions.conflict || sessions.awaitingChoice || finishing
  return <main className={`app-shell phase-${lifecycle}`}>
    <header className="app-header"><h1>ForexTester</h1><span className="header-session"><span className="session-name">{sessions.name}</span> <span className="save-state">{history ? sessions.saveStatus : 'Not started'}</span></span>
      {lifecycle === 'trading' && <details ref={executionDetails} className="execution-details"><summary aria-label="Execution details" title="Execution details"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v2"/></svg></summary><div className="execution-popover">
        <strong>Execution details</strong>
        <p>While paused: Shift + Right completes the active chart’s next candle. Shift + Left reviews earlier candles without rewinding trade execution. Select a chart by clicking, panning, scrolling or changing its timeframe. Return to current replay to trade.</p>
        {history && isSinglePrice(history) ? <p>6E trade prices · hypothetical forex-style sizing (1 lot = 100,000 EUR). No spread; entries fill at the next eligible M1 opening, with high/low stops and gap-open handling. Not exchange-accurate futures or EUR/USD CFD execution.</p> : <p>Original legacy bid/ask execution. Entries fill at the next synchronized M1 opening.</p>}
        <p>SL amounts are net at the stop level, including entry and exit commissions. Pending values estimate the next fill from the observed price. Gaps can change the outcome. Entry lines mark the fill price; net breakeven also includes commissions.</p>
        {history && isSinglePrice(history) && <details><summary>Contract mappings and rollover events</summary>{history.contracts.map(c=><p key={c.from}>{c.from} to {c.to} (exclusive): {c.rawSymbol} · instrument {c.instrumentId}</p>)}</details>}
      </div></details>}
      {lifecycle === 'trading' && (
        <fieldset className="header-replay" aria-label="Market replay" disabled={workspaceDisabled || status === 'loading' || pendingStart || manage || confirming || !!stopPreview} hidden={!sessions.initialized || sessions.awaitingChoice}>
          <button disabled={!replay.canPlay || !!stopPreview} onClick={()=>{setDraft(null);replay.play()}}>Play</button><button disabled={!replay.canPause} onClick={replay.pause}>Pause</button><button disabled={!replay.canNext || !!stopPreview} onClick={()=>{setDraft(null);replay.next()}}>Next Candle</button>
          <label>Speed<select aria-label="Replay speed" value={replay.speed} onChange={e=>replay.setSpeed(Number(e.target.value) as 1|10|100)}>{[1,10,100].map(s=><option key={s} value={s}>{s}×</option>)}</select></label>
          {chartLayout}<div className="replay-state"><span aria-label="Replay status" className="replay-status">{replay.status}</span><span className="replay-progress" aria-label="Replay progress">{replay.revealed-replay.startIndex} / {replay.total-replay.startIndex} candles</span></div><button disabled={replay.reviewing} onClick={()=>void finish()}>{replay.complete ? 'Review Results' : 'Finish backtest'}</button>
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
        <div className="setup-heading"><h2>Set up a backtest</h2><p>Choose downloaded history and start a paused, indicator-ready replay.</p></div>
        {!!sessions.legacySessions.length && <p className="chart-note">Older browser backtests are available. <button type="button" onClick={()=>setManage(true)}>Review browser backtests</button></p>}
        <form onSubmit={loadData} className="setup-form" id="setup-form">
          <section className="historical-period"><h3>Historical period <span>6E · M1 · UTC</span></h3>
            {calendar?.days.length ? <HistoryTimeline calendar={calendar} range={{from,to}} disabled={status === 'loading'} onEndChange={()=>setEndMoved(true)} onChange={range=>{selectionTouched.current=true;setFrom(range.from);setTo(range.to);setFormError(null);setError(null)}}/> : <p role="status">{coverageError ? 'Downloaded history could not be checked.' : calendar ? 'No downloaded history yet. Get historical data to begin.' : 'Checking downloaded history…'} {coverageError && <button type="button" onClick={()=>void refreshCoverage()}>Retry coverage</button>}</p>}
            <div className="period-shortcuts">{[7,30,90].map((days,index)=><button type="button" key={days} disabled={status === 'loading' || !calendar || !presets[index]} aria-pressed={selected.days === days} onClick={()=>{const range=presets[index];if(range){selectionTouched.current=true;setFrom(range.from);setTo(range.to);setFormError(null);setError(null)}}}>{days} days</button>)}<span>{Number.isFinite(selected.days) ? selected.days : 0} calendar days · maximum 90</span></div>
            <div className="period-readiness" role="status">{calendar && (()=>{
              if (selected.error) return <p className="form-error">Choose 1 to 90 completed UTC calendar days.</p>
              if (!readiness) return null
              return <><p><strong>{readiness.missing ? `${readiness.missing} missing days require a Databento download.` : `${selected.days} days selected — already downloaded.`}</strong></p>
                {!readiness.missing && <p>No additional data required. Includes the 30-day indicator pre-roll.</p>}
                {readiness.replay && <><p>Replay begins automatically: <strong>{formatUtcDate(readiness.replay.timestamp)}, {new Date(readiness.replay.timestamp).toISOString().slice(11,16)} UTC</strong></p><p>{readiness.replay.count} completed H4 candles available · {readiness.replay.required} required for Ichimoku.</p>{readiness.replay.timestamp > Date.parse(from) && <p className="coverage-warning">The first tradable minute is later than your From date because of market closures, missing observations or indicator warm-up.</p>}</>}
                {!readiness.missing && !readiness.replay && <p className="form-error">Insufficient historical candles for Ichimoku. Select a later starting period or a longer interval.</p>}
              </>
            })()}</div>
            {calendar && (()=>{const bars=calendar.days.filter(day=>day.date>=from && day.date<to).flatMap(day=>day.h4);return bars.some((bar,index)=>index>0 && (bar as {instrumentId?:number}).instrumentId !== (bars[index-1] as {instrumentId?:number}).instrumentId) ? <p className="coverage-warning">Replay will pause at the next futures contract change.</p> : null})()}
            <button type="button" className="more-history" disabled={status === 'loading'} onClick={()=>setMoreData(value=>!value)}>Get more historical data</button>
            {moreData && <div className="more-history-fields"><p>Choose dates to estimate only missing data. Downloading requires your explicit paid approval.</p>{dateFields}</div>}
          </section>
          <section className="setup-account"><h3>Trading account <span>USD</span></h3><div className="account-fields">
            <label>Starting balance (USD)<input aria-label="Starting balance (USD)" type="number" min="0" step="any" disabled={status === 'loading'} value={trading.state.account.referenceBalance || ''} onChange={e=>trading.configure({...trading.state.account,referenceBalance:Number(e.target.value)})}/></label>
            <label>Maximum combined gross risk (%)<input aria-label="Maximum combined gross planned risk (%)" type="number" min="0" max="100" step="any" disabled={status === 'loading'} value={trading.state.account.maxRiskPercent || ''} onChange={e=>trading.configure({...trading.state.account,maxRiskPercent:Number(e.target.value)})}/></label>
          </div></section>
          <details className="setup-advanced"><summary>Advanced settings</summary><div className="advanced-fields">
            <label>Backtest name<input maxLength={200} aria-label="Backtest name" disabled={status === 'loading'} value={sessions.name} onChange={e=>sessions.editName(e.target.value)}/></label>
            <label>Round-trip commission ($ / standard lot)<input aria-label="Round-trip commission (USD per standard lot)" type="number" min="0" step="any" disabled={status === 'loading'} value={trading.state.commission.roundTripUsdPerLot} onChange={e=>{const value={roundTripUsdPerLot:Number(e.target.value)};setFormError(commissionConfigError(value));trading.configureCommission(value)}}/></label>
            <div className="initial-layout">{chartLayout}</div>
            {!moreData && <div><h4>Manual historical dates</h4>{dateFields}</div>}
            <p className="chart-note">30-day pre-roll · 6E Euro FX futures · Databento GLBX.MDP3 · ohlcv-1m. Hypothetical forex-style sizing; no synthetic spread. Commission is split between entry and exit.</p>
          </div></details>
        </form>
          <footer className="setup-footer"><div aria-live="polite">
            {(formError || accountRiskError(trading.state.account) || commissionConfigError(trading.state.commission)) && <p className="form-error">{formError || accountRiskError(trading.state.account) || commissionConfigError(trading.state.commission)}</p>}
            {status === 'loading' && <div role="status"><p>Preparing charts and indicators…</p>{!paidPending && <button type="button" onClick={()=>{loadGeneration.current++;loadAbort.current?.abort();starting.current=false;setPendingStart(false);setStatus('idle');setQuote(null)}}>Cancel loading</button>}<progress max={loadProgress.total || 1} value={loadProgress.completed}/></div>}
            {status === 'error' && <p className="form-error" role="alert">{error}</p>}
            {downloadNotice && <p role="status">{downloadNotice}</p>}
            {paidPending && <p role="status">Approved download in progress. Closing this page does not cancel a paid request.</p>}
          </div><button type="submit" form="setup-form" className="primary-action" disabled={status === 'loading' || !!selected.error || !!accountRiskError(trading.state.account) || !!commissionConfigError(trading.state.commission) || !!(readiness && !readiness.missing && !readiness.replay)}>Start backtest</button></footer>
      </section>}
      {lifecycle === 'setup' && confirming && quote && quote.tradingFrom === from && quote.to === to && <PaidDownloadDialog key={quote.id} quote={quote} onCancel={()=>{setConfirming(false);setQuote(null);setDownloadNotice('Download cancelled. No paid request submitted and no additional budget reserved.')}} onApprove={()=>void confirmDownload()}/>}
      {lifecycle === 'trading' && <>
        <div className="workspace-toolbar" role="region" aria-label="Trading workspace controls">
        <TradingDock reviewing={replay.reviewing} shortcutsBlocked={manage || !!stopPreview || status === 'loading' || confirming || paidPending || pendingStart} stops={stops} key={`${sessions.activeId}-${trading.state.session}`} trading={trading} draft={draft} setDraft={setDraft} onConfirm={confirmDraft}/>
        </div>
        {replay.reviewing && <div className="history-review" role="status"><strong>Reviewing history</strong><span>{new Date(replay.reviewTimestamp!).toISOString().slice(0,16).replace('T',' ')} UTC · Trading disabled</span><button onClick={replay.returnToCurrent}>Return to current replay</button></div>}
        {keyboardNotice && <p className="keyboard-notice" role="status">{keyboardNotice}</p>}
        {replay.blocked && <p className="coverage-warning" role="alert">Replay blocked at contract rollover. No positions, stops or pending orders were executed across the boundary. Finish this backtest or select a replay start after the rollover. A carry/roll policy requires project-lead approval.</p>}
        <div className="chart-workspace" aria-label={`${history?.symbol === '6E' ? 'EURUSD 6E' : history?.symbol ?? 'EURUSD 6E'} chart workspace`}><div className={`chart-stack charts-${chartCount}`}>
          {timeframes.slice(0,chartCount).map((timeframe,id)=><ChartPane key={id} instrument={history?.symbol ?? '6E'} id={id} active={id === activeChart} reviewing={replay.reviewing} timeframe={timeframe} sessionId={sessions.activeId} positions={replay.reviewing ? [] : trading.state.positions} entries={replay.reviewing ? [] : entries} onConfirmStop={confirmDraft} confirmStopDisabled={draftInvalid} stops={replay.reviewing ? [] : stops} stopInteraction={{ enabled: canRequestOrder(trading.permission) && !draft,
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
        start={startMs} endpoint={replay.timestamp} singlePrice={!!history && isSinglePrice(history)} onSave={sessions.save} />}
    </fieldset>
  </main>
}
