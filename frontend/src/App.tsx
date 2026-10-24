import { quoteHistory, downloadHistory, type HistoryQuote } from './databentoHistory'
import { historyCandles, historyLabel, isSinglePrice } from './history'
import { flushSync } from 'react-dom'
import { PaidDownloadDialog, cacheBreakdown, usd } from './PaidDownloadDialog'
import { ManagementDialog } from './ManagementDialog'
import { ChartPane } from './ChartPane'
import { TradingDock, type StopDraft } from './TradingDock'
import { accountPnl, selectedRange, shiftDate, type Coverage } from './workflow'
import { lifecycleOf, type Lifecycle } from './sessionTypes'
import { commissionConfigError } from './commissions'
import { defaultWorkspace, readUi, useUiValue, validWorkspace, writeUi } from './uiPreferences'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { SessionControls } from './SessionControls'
import { useSessionPersistence } from './useSessionPersistence'
import { equitySummary, type Hydration, type SessionSnapshot, type WorkspaceSettings } from './sessionTypes'
import type { AnalyticsScope } from './analytics'
import { ChartSynchronizer } from './chartSync'
import { useReplay } from './useReplay'
import { accountRiskError } from './risk'
import { useTrading } from './useTrading'
import { TradingJournal } from './TradingJournal'
import { indicatorPreset, type IndicatorSettings } from './indicators'
import { HistoryLoader, ichimokuWarmup, replayStartIndex, type LoadProgress, type LoadedHistory } from './historyLoader'
import { EquityChart } from './EquityChart'
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
  const [draft, setDraft] = useState<StopDraft | null>(null)
  const [manage, setManage] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [resultSection, setResultSection] = useState<'summary' | 'journal' | 'equity'>('summary')
  const [coverage, setCoverage] = useState<Coverage | null>(null)
  const [coverageError, setCoverageError] = useState(false)
  const loadAbort = useRef<AbortController | null>(null)
  const loadGeneration = useRef(0)
  const [error, setError] = useState<string | null>(null)
  const [historyFailure, setHistoryFailure] = useState<HistoryRequestError | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [loader] = useState(() => new HistoryLoader())
  const [loadProgress, setLoadProgress] = useState<LoadProgress>({ completed: 0, total: 0 })
  const [replayStart, setReplayStart] = useState('')
  const [hydration, setHydration] = useState<Hydration | null>(null)

  const source = history ? historyCandles(history) : EMPTY_CANDLES
  const tradingFrom = history?.tradingFrom ?? requestedRange.from
  const startMs = Date.parse(`${replayStart || `${tradingFrom}T00:00`}:00Z`)
  const startIndex = useMemo(() => replayStartIndex(source, startMs), [history, startMs])
  const replay = useReplay(history ? source : null, startIndex, hydration ? { replay: hydration.checkpoint.replay, epoch: hydration.checkpoint.trading.session } : null)
  const trading = useTrading(history, replay, hydration)
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
  const warmup = useMemo(() => ichimokuWarmup(chartSource, startMs), [chartSource, startMs])
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
      loadGeneration.current++; loadAbort.current?.abort(); setDraft(null); setManage(false); setLifecycle(lifecycleOf(saved.checkpoint)); setResultSection('summary')
      setHydration(saved); setHistory(source); setRequestedRange(saved.record.range)
      setFrom(saved.record.range.from); setTo(saved.record.range.to)
      setReplayStart(new Date(saved.checkpoint.replay.startTimestamp).toISOString().slice(0, 16))
      setStatus('ready'); setError(null); setFormError(null); setQuote(null); setConfirming(false)
    },
    fresh: (range) => {
      loadGeneration.current++; loadAbort.current?.abort(); setDraft(null); setLifecycle('setup'); setStatus('idle'); setReplayStart(''); setManage(false)
      setQuote(null); setConfirming(false); setHydration(null); setHistory(null); setRequestedRange({ ...range }); setFrom(range.from); setTo(range.to)
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

  async function refreshCoverage() {
    try { const response = await fetch('/api/history/coverage'); const value = await response.json(); if (!response.ok) throw Error(); if (!value.latestEligibleDate) throw Error(); setCoverage(value); setCoverageError(false) }
    catch { setCoverageError(true) }
  }
  useEffect(() => { void refreshCoverage(); return () => { loadAbort.current?.abort(); loadGeneration.current++ } }, [])
  useEffect(() => { if (replay.playing) setDraft(null) }, [replay.playing])
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setDraft(null); setManage(false) } }
    window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape)
  }, [])
  useEffect(() => { setQuote(null); setConfirming(false) }, [from, to])
  const pickStop = useCallback((price: number) => setDraft(d => d ? { ...d, price } : null), [])
  async function loadData(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    const selected = selectedRange(from, shiftDate(to, -1), coverage)
    setFormError(selected.error)
    if (selected.error || paidSubmitting.current) return
    setQuote(null); setConfirming(false); setDownloadNotice(null)
    const generation = ++loadGeneration.current
    loadAbort.current?.abort()
    const controller = new AbortController(); loadAbort.current = controller
    setStatus('loading'); setError(null); setHistoryFailure(null); setRequestedRange(selected.range)
    try {
      await sessions.flush()
      const estimate = await quoteHistory(selected.range, controller.signal)
      if (generation !== loadGeneration.current) return
      setQuote(estimate)
      if (!estimate.cached) { setStatus('idle'); setConfirming(true); return }
      const result = await loader.load(selected.range, controller.signal, setLoadProgress)
      if (generation !== loadGeneration.current) return
      const chosenName = sessions.name, chosenStart = replayStart
      if (history && !await sessions.fresh(selected.range)) throw new Error('The previous backtest could not be saved. New data remains cached; retry storage before switching.')
      // Name updates flush persistence immediately, so install the new history first.
      flushSync(() => { setReplayStart(chosenStart); setHydration(null); setHistory(result); setStatus('ready') })
      sessions.editName(chosenName); void refreshCoverage()
    } catch (reason) {
      if (generation !== loadGeneration.current || controller.signal.aborted) return
      setHistoryFailure(reason instanceof HistoryRequestError ? reason : null)
      setError(reason instanceof Error ? reason.message : 'Historical data unavailable.'); setStatus('error'); void refreshCoverage()
    }
  }
  async function confirmDownload() {
    if (!quote || quote.tradingFrom !== from || quote.to !== to || !quote.downloadAllowed || Date.now() >= Date.parse(quote.expiresAt) || paidSubmitting.current) return
    paidSubmitting.current = true; setPaidPending(true); setConfirming(false); setDownloadNotice(null)
    const generation = ++loadGeneration.current
    const controller = new AbortController(); loadAbort.current = controller
    setStatus('loading'); setError(null); setHistoryFailure(null); setLoadProgress({ completed: 0, total: 1 })
    try {
      await sessions.flush()
      if (Date.now() >= Date.parse(quote.expiresAt)) throw new Error('Quote expired. Load historical data again for a fresh estimate.')
      const result = await downloadHistory(quote, controller.signal)
      if (generation !== loadGeneration.current) return
      const chosenName = sessions.name, chosenStart = replayStart
      if (history && !await sessions.fresh({ from: quote.tradingFrom, to: quote.to })) throw new Error('The previous backtest could not be saved. Downloaded data remains cached; retry storage before switching.')
      flushSync(() => { setReplayStart(chosenStart); setHydration(null); setHistory(result); setStatus('ready'); setLoadProgress({ completed: 1, total: 1 }); setQuote(null) })
      sessions.editName(chosenName)
    } catch (reason) {
      if (generation !== loadGeneration.current || controller.signal.aborted) return
      setHistoryFailure(reason instanceof HistoryRequestError ? reason : null)
      setError(reason instanceof Error ? reason.message : 'Historical download failed.'); setStatus('error'); setQuote(null)
      setDownloadNotice('A paid submission may already have reached the backend. Closing this page does not guarantee no charge. Wait for the backend to finish, then load again to inspect the cache; no request is retried automatically.')
    } finally { paidSubmitting.current = false; setPaidPending(false) }
  }
  async function finish() {
    flushSync(() => { replay.pause(); setDraft(null); setFinishing(true) })
    try {
      await sessions.flush()
      if (!window.confirm(`Finish this backtest? ${trading.state.positions.length} open positions, ${trading.state.pending.length} pending entries and ${trading.state.positions.filter(p=>p.closeRequestedAt !== null).length} pending closes remain. No exits will be created. Results include unrealized account PnL separately from realized statistics.`)) return
      flushSync(() => { setLifecycle('finished'); setResultSection('summary') })
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

  const replayStartError = !Number.isFinite(startMs) || startMs < Date.parse(tradingFrom) || startMs >= Date.parse(requestedRange.to)
  const pnl = accountPnl(trading.equity, trading.state.account.referenceBalance)
  const selected = selectedRange(from, shiftDate(to, -1), coverage)
  const chartLayout = <fieldset className="layout-controls"><legend>Charts</legend>{[1,2,3].map(count=><label key={count}><input type="radio" name="chart-count" value={count} checked={chartCount === count} onChange={()=>{ synchronizer.deactivate(); setChartCount(count) }}/>{count}</label>)}</fieldset>
  const pnlDisplay = <div className={`account-pnl ${pnl && Math.abs(pnl.usd) >= 0.005 ? pnl.usd > 0 ? 'positive' : 'negative' : ''}`} aria-label="Account PnL"><span>Account PnL</span><strong>{pnl ? `$${pnl.usd.toFixed(2)} · ${pnl.percent.toFixed(2)}%` : 'PnL unavailable'}</strong></div>
  return <main className={`app-shell phase-${lifecycle}`}>
    <header className="app-header"><h1>ForexTester</h1><span className="header-session">{sessions.name} <span className="save-state">{history ? sessions.saveStatus : 'Not started'}</span></span>
      {lifecycle !== 'setup' && pnlDisplay}<button onClick={()=>{ replay.pause(); setDraft(null); setManage(true) }}>Sessions / settings</button>
    </header>
    {sessions.error && !manage && !sessions.awaitingChoice && <p className="form-error critical-save" role="alert">{sessions.error} <button onClick={()=>setManage(true)}>Open storage controls</button></p>}
    {sessions.awaitingChoice && !manage && <section className="startup-selection" aria-label="Choose a backtest"><SessionControls startup sessions={sessions} range={{from:tradingFrom,to:history?.to ?? requestedRange.to}} timestamp={replay.timestamp}/></section>}
    {manage && <ManagementDialog required={false} onClose={()=>setManage(false)}>
      <button className="close-management" onClick={()=>setManage(false)}>Close management</button>
      <SessionControls sessions={sessions} range={{from:tradingFrom,to:history?.to ?? requestedRange.to}} timestamp={replay.timestamp}/>
      {lifecycle === 'trading' && <button onClick={()=>{ restart(); setManage(false) }}>Restart backtest</button>}
    </ManagementDialog>}
    {!sessions.initialized && !sessions.awaitingChoice && <p className="startup-status" role="status">Checking saved backtests…</p>}
    <fieldset className="workspace-controls" disabled={!sessions.initialized || sessions.busy || sessions.conflict || sessions.awaitingChoice || finishing} hidden={!sessions.initialized || sessions.awaitingChoice}>
      {lifecycle === 'setup' && <section className="setup-workspace" aria-label="Backtest setup">
        <div className="setup-heading"><h2>Set up a backtest</h2><p>Configure your account, load a historical period, then start replay.</p></div>
        {!!sessions.legacySessions.length && <p className="chart-note">Older browser backtests are available. <button type="button" onClick={()=>setManage(true)}>Review browser backtests</button></p>}
        <label className="backtest-name">Backtest name<input maxLength={200} aria-label="Backtest name" value={sessions.name} onChange={e=>sessions.editName(e.target.value)}/></label>
        <form onSubmit={loadData} className="setup-grid">
          <section><h3>Historical period <span>6E — Euro FX Futures · Databento · M1 · UTC</span></h3>
            {coverage?.cachedFrom ? <div className="coverage-summary"><p>Validated local cache: <strong>{coverage.cachedDates} calendar dates</strong></p><p>Cache bounds: {coverage.cachedFrom} to {coverage.cachedTo} (end exclusive).</p><small>Provider historical availability has not been verified. Additional data requires Databento access. Selected dates are checked individually when loading; cached dates load without an API key.</small></div> : coverage?.providerEarliestTimestamp ? <div className="coverage-summary"><p>Earliest advertised M1: <strong>{coverage.providerEarliestTimestamp.replace('T',' ').replace('.000Z',' UTC')}</strong></p><p>Latest eligible date: <strong>{coverage.latestEligibleDate}</strong></p><small>Metadata availability includes the required 30-day indicator pre-roll. Untraded minutes and exchange closures remain gaps.</small></div> : <p role="status">{coverageError ? 'Live coverage unavailable. Additional data requires Databento access; validated cached dates still load offline.' : 'Reading historical coverage…'} <button type="button" onClick={()=>void refreshCoverage()}>Retry coverage</button></p>}
            <div className="period-fields"><label>From<input aria-label="From" type="date" min={coverage?.providerHealth.status === 'metadata-verified' ? coverage.earliestSelectableDate ?? undefined : undefined} max={coverage?.latestEligibleDate} value={from} disabled={status === 'loading'} onChange={e=>{setFrom(e.target.value);setFormError(null)}}/></label>
              <label>Through <span>(inclusive)</span><input aria-label="Through" type="date" min={from || undefined} max={coverage?.latestEligibleDate} value={shiftDate(to,-1)} disabled={status === 'loading'} onChange={e=>{setTo(shiftDate(e.target.value,1));setFormError(null)}}/></label></div>
            <div className="period-shortcuts">{[7,30,90].map(days=><button type="button" key={days} disabled={!coverage || status === 'loading'} onClick={()=>{setTo(shiftDate(coverage!.latestEligibleDate,1));setFrom(shiftDate(coverage!.latestEligibleDate,1-days))}}>{days} days</button>)}<span>{Number.isFinite(selected.days) ? selected.days : 0} calendar days · maximum 90</span></div>
            <p className="chart-note">All dates and replay times use UTC. Select historical years directly in the date fields.</p>
            {formError && <p className="form-error" role="alert">{formError}</p>}
            <div className="load-actions"><button type="submit" disabled={status === 'loading'}>{status === 'error' ? 'Retry historical data' : 'Load historical data'}</button>
              {status === 'loading' && !paidPending && <button type="button" onClick={()=>{loadGeneration.current++;loadAbort.current?.abort();setStatus('idle');setQuote(null)}}>Cancel loading</button>}</div>
            {paidPending && <p role="status">Paid request submitted. The backend may already be downloading; closing or refreshing this page does not guarantee no charge.</p>}
            {downloadNotice && <p role="status">{downloadNotice}</p>}
            {status === 'loading' && <div role="status"><progress max={loadProgress.total || 1} value={loadProgress.completed}/><p>{loadProgress.completed} / {loadProgress.total} history chunks loaded</p></div>}
            {status === 'error' && <div className="load-error" role="alert"><strong>{historyFailure?.title ?? 'Historical data unavailable'}</strong><p>{error}</p>
              {historyFailure?.retryAfterMs !== undefined && <p>The provider requested a wait of at least {Math.ceil(historyFailure.retryAfterMs / 1000)} seconds before another attempt. A retry may still fail.</p>}
              <p>Configure Databento on the backend as described in README. New downloads require a current quote, usable credits and explicit confirmation.</p></div>}
            {quote && quote.tradingFrom === from && quote.to === to && <div className={`coverage-summary ${quote.cached ? 'cached-history-status' : ''}`} role="status">
              <p><strong>{cacheBreakdown(quote).label}</strong>{quote.cached ? ' · No additional download required.' : ''}</p>
              <p>{cacheBreakdown(quote).cached} calendar dates cached · {cacheBreakdown(quote).missing} additional dates needed, including 30-day pre-roll.</p>
              <p>Estimated new download: <strong>{usd(quote.estimatedUsd)}</strong></p>
              {quote.blockedReason && <p className="form-error">{quote.blockedReason}</p>}
              {!quote.cached && <button type="button" disabled={status === 'loading'} onClick={()=>setConfirming(true)}>Review paid download</button>}
            </div>}
            {status === 'ready' && history && <p className="data-ready" role="status">Loaded {source.length.toLocaleString()} {isSinglePrice(history) ? 'trade-price M1 candles' : 'legacy bid observations'}, including indicator pre-roll.</p>}
            <p className="chart-note">Hypothetical forex-style sizing applied to 6E-derived trade prices. No synthetic spread. Simplified fills do not represent EUR/USD CFD execution or exchange-accurate futures contracts.</p>

          </section>
          <section><h3>Account <span>USD</span></h3><div className="account-fields">
            <label>Starting balance (USD)<input aria-label="Starting balance (USD)" type="number" min="0" step="any" value={trading.state.account.referenceBalance || ''} onChange={e=>trading.configure({...trading.state.account,referenceBalance:Number(e.target.value)})}/></label>
            <label>Maximum combined risk (%)<input aria-label="Maximum combined gross planned risk (%)" type="number" min="0" max="100" step="any" value={trading.state.account.maxRiskPercent || ''} onChange={e=>trading.configure({...trading.state.account,maxRiskPercent:Number(e.target.value)})}/></label>
            <label>Round-trip commission ($ / standard lot)<input aria-label="Round-trip commission (USD per standard lot)" type="number" min="0" step="any" value={trading.state.commission.roundTripUsdPerLot} onChange={e=>{const value={roundTripUsdPerLot:Number(e.target.value)};setFormError(commissionConfigError(value));trading.configureCommission(value)}}/></label>
            <label>Replay start (UTC)<input aria-label="Replay start (UTC)" type="datetime-local" min={`${from}T00:00`} max={`${shiftDate(to,-1)}T23:59`} value={replayStart || `${from}T00:00`} onChange={e=>setReplayStart(e.target.value)}/></label>
          </div><p className="chart-note">Account settings lock when you start. Commission is split between entry and exit.</p><div className="initial-layout">{chartLayout}</div></section>
        </form>
        <footer className="setup-footer"><div>{history && !warmup.ready && <p className="coverage-warning">Indicator warm-up incomplete: {warmup.count} prior H4 candles; {warmup.required} required for the default Ichimoku cloud.</p>}
          {history && replayStartError && <p className="form-error">Choose a replay start within the loaded interval.</p>}
          {history && startIndex >= source.length && <p className="form-error">No bid observations at or after the replay start.</p>}
          {accountRiskError(trading.state.account) && <p className="form-error">{accountRiskError(trading.state.account)}</p>}
        </div><button className="primary-action" disabled={status !== 'ready' || !replay.canStart || replayStartError || !!accountRiskError(trading.state.account) || from !== requestedRange.from || to !== requestedRange.to} onClick={()=>{setDraft(null);setLifecycle('trading');replay.start()}}>Start backtest</button></footer>
      </section>}
      {lifecycle === 'setup' && confirming && quote && quote.tradingFrom === from && quote.to === to && <PaidDownloadDialog key={quote.id} quote={quote} onCancel={()=>{setConfirming(false);setQuote(null);setDownloadNotice('Download cancelled. No paid request submitted and no additional budget reserved.')}} onApprove={()=>void confirmDownload()}/>}
      {lifecycle === 'trading' && <>
        <div className="replay-strip" role="group" aria-label="Market replay"><strong>{historyLabel(history)}</strong><time className="replay-clock">{replay.timestamp === null ? 'Awaiting replay' : new Date(replay.timestamp).toISOString().slice(0,16).replace('T',' ') + ' UTC'}</time>
          <button disabled={!replay.canPlay} onClick={()=>{setDraft(null);replay.play()}}>Play</button><button disabled={!replay.canPause} onClick={replay.pause}>Pause</button><button disabled={!replay.canNext} onClick={()=>{setDraft(null);replay.next()}}>Next Candle</button>
          <label>Speed<select aria-label="Replay speed" value={replay.speed} onChange={e=>replay.setSpeed(Number(e.target.value) as 1|10|100)}>{[1,10,100].map(s=><option key={s} value={s}>{s}×</option>)}</select></label>
          {chartLayout}<span aria-label="Replay status" className="replay-status">{replay.status}</span><span className="replay-progress" aria-label="Replay progress">{replay.revealed-replay.startIndex} / {replay.total-replay.startIndex} candles</span><button onClick={()=>void finish()}>{replay.complete ? 'Review Results' : 'Finish backtest'}</button>
        </div>
        {replay.blocked && <p className="coverage-warning" role="alert">Replay blocked at contract rollover. No positions, stops or pending orders were executed across the boundary. Finish this backtest or select a replay start after the rollover. A carry/roll policy requires project-lead approval.</p>}
        {history && isSinglePrice(history) && <details className="chart-note"><summary>Contract mappings and rollover events</summary>{history.contracts.map(c=><p key={c.from}>{c.from} to {c.to} (exclusive): {c.rawSymbol} · instrument {c.instrumentId}</p>)}</details>}
        <div className="chart-workspace" aria-label={`${history?.symbol ?? '6E'} chart workspace`}><div className="chart-stack" style={{gridTemplateRows:`repeat(${chartCount}, minmax(0, 1fr))`}}>
          {timeframes.slice(0,chartCount).map((timeframe,id)=><ChartPane key={id} instrument={history?.symbol ?? '6E'} id={id} timeframe={timeframe} sessionId={sessions.activeId} positions={trading.state.positions} source={chartSource} count={Math.max(0, replay.count - chartOffset)} synchronizer={synchronizer} onTimeframeChange={changeTimeframe} settings={indicatorSettings[id][timeframe]!} onSettingsChange={changeSettings} placement={draft} onPick={pickStop}/>)}</div></div>
        <TradingDock key={`${sessions.activeId}-${trading.state.session}`} trading={trading} draft={draft} setDraft={setDraft}/>
      </>}
      {lifecycle === 'finished' && <section className="results-workspace" aria-label="Backtest results"><div className="results-heading"><h2>Backtest results</h2><button onClick={sessions.save}>Save now</button></div>
        <p className="chart-note">{historyLabel(history)} · {history && isSinglePrice(history) ? 'Hypothetical forex-style sizing; simplified trade-price fills.' : 'Original legacy execution model.'}</p><p className="results-disclosure">{trading.state.positions.length} positions remain open · {trading.state.pending.length} entries pending. Account PnL includes open equity; journal statistics use completed trades. No exits were created when finishing.</p>
        <nav className="results-navigation" aria-label="Results sections">{([['summary','Overview'],['journal','Journal'],['equity','Equity & drawdown']] as const).map(([key,label])=><button key={key} aria-pressed={resultSection === key} onClick={()=>setResultSection(key)}>{label}</button>)}</nav>
        {resultSection !== 'equity' && <TradingJournal section={resultSection} sessionId={sessions.activeId} key={`${sessions.activeId}-${trading.state.session}`} state={trading.state} onUpdateSetup={trading.updateSetup} scope={statisticsScope} view={journalScope} onScopeChange={setStatisticsScope} onViewChange={setJournalScope}/>}
        {resultSection === 'equity' && <EquityChart sessionId={sessions.activeId} ledger={trading.equity} referenceBalance={trading.state.account.referenceBalance}/>}
      </section>}
    </fieldset>
  </main>
}
