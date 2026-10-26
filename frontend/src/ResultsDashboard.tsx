import { Fragment, memo, useMemo, useState } from 'react'
import { journalSetups, type SetupJournalRow } from './analytics'
import type { EquityLedger } from './equity'
import { downloadJournalCsv } from './journalCsv'
import { completedSetups, equityPerformance, setupPerformance } from './resultsAnalytics'
import { decimal, duration, outcomeClass, percent, profitFactor, rValue, usd } from './resultsFormatting'
import { Help, ResultsCharts } from './ResultsCharts'
import { PositionDetails } from './TradingJournal'
import { tradingTime, type TradingState } from './trading'

function SetupBreakdown({ state, rows }: { state: TradingState; rows: readonly SetupJournalRow[] }) {
  const [expanded, setExpanded] = useState<string | null>(null)
  return <details className="results-breakdown"><summary>Setup breakdown <span>{rows.length} setups · Expand / Collapse</span></summary>
    <p className="results-caption">Original risk includes executed positions only. Unfinished setups show partial realized PnL; final net R is unavailable.</p>
    {!rows.length ? <p className="journal-empty">No setups recorded.</p> : <div className="results-table-scroll" role="region" aria-label="Setup breakdown table" tabIndex={0}>
      <table className="results-table"><caption className="results-visually-hidden">One trading decision per setup; expand a setup for its individual positions</caption>
        <thead><tr>{['Setup ID', 'Direction', 'Executed positions', 'Status', 'Net PnL (USD)', 'Net R'].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
        <tbody>{rows.map(row => <Fragment key={row.setup.id}>
          <tr data-setup-id={row.setup.id}><th scope="row"><button type="button" aria-label={`Details for setup ${row.setup.id}`} aria-expanded={expanded === row.setup.id} aria-controls={`results-${row.setup.id}`} onClick={() => setExpanded(expanded === row.setup.id ? null : row.setup.id)}>{row.setup.id}<span aria-hidden="true">{expanded === row.setup.id ? ' −' : ' +'}</span></button>
            {row.coverageUncertain && <span className="partial-result">Coverage warning</span>}</th>
            <td>{row.setup.direction}</td><td>{row.positions.length}</td><td>{row.status}</td>
            <td className={outcomeClass(row.netPnlUsd)}>{usd(row.netPnlUsd, true)}{row.status !== 'completed' && <span className="partial-result">Partial realized PnL</span>}</td><td>{rValue(row.netR)}</td></tr>
          {expanded === row.setup.id && <tr id={`results-${row.setup.id}`}><td colSpan={6} className="results-setup-details">
            {(row.setup.title || row.setup.tag || row.setup.notes) && <div className="results-stored-metadata"><strong>{row.setup.title}</strong>{row.setup.tag && <span>Tag: {row.setup.tag}</span>}{row.setup.notes && <p>{row.setup.notes}</p>}</div>}
            <div className="results-position-grid">{row.positions.map(position => <PositionDetails key={position.id} position={position} />)}</div>
            {!row.positions.length && <p>No executed positions.</p>}
            {state.pending.filter(entry => entry.setupId === row.setup.id).map(entry => <p key={entry.id}>Pending entry {entry.id} · {entry.direction} · SL {decimal(entry.stopPrice, 5)} · Requested {tradingTime(entry.requestedAt)}</p>)}
            {state.rejected.filter(entry => entry.setupId === row.setup.id).map(entry => <p key={entry.id}>Rejected entry {entry.id} · {tradingTime(entry.rejectedAt)} · {entry.reason}</p>)}
            {state.cancelled.filter(entry => entry.setupId === row.setup.id).map(entry => <p key={entry.id}>Cancelled entry {entry.id} · {tradingTime(entry.cancelledAt)}</p>)}
          </td></tr>}
        </Fragment>)}</tbody>
      </table></div>}
  </details>
}

export const ResultsDashboard = memo(function ResultsDashboard({ state, ledger, start, endpoint, singlePrice, onSave, onResume, reviewOnly, resumeDisabled }: {
  state: TradingState; ledger: EquityLedger; start: number; endpoint: number | null; singlePrice: boolean; onSave: () => void
  onResume: () => void; reviewOnly: boolean; resumeDisabled: boolean
}) {
  const referenceBalance = state.account.referenceBalance
  const rows = useMemo(() => journalSetups(state), [state])
  const completed = useMemo(() => completedSetups(state), [state])
  const positions = useMemo(() => [...state.positions, ...state.closed], [state.positions, state.closed])
  const stats = useMemo(() => setupPerformance(completed, referenceBalance), [completed, referenceBalance])
  const equity = useMemo(() => equityPerformance(ledger, referenceBalance), [ledger, referenceBalance])
  const partial = rows.filter(row => row.status === 'partially closed').length
  const unresolved = state.positions.length > 0 || state.pending.length > 0
  const peakContext = equity.maxPeakDrawdownPercent === null ? 'Percentage unavailable' : equity.maxPeakDrawdownPercent === 0 ? 'No observed decline from peak'
    : equity.peakPoint ? `${tradingTime(equity.peakPoint.timestamp)} · ${usd(equity.peakPoint.drawdownUsd)} below peak` : 'N/A'
  const primary = [
    { label: 'Net return', value: percent(equity.netReturnPercent, true), context: `${usd(equity.netReturnUsd, true)} · Account equity ${usd(equity.currentEquityUsd)}`, sign: outcomeClass(equity.netReturnUsd), help: 'Current M1 ledger equity minus initial capital, divided by fixed initial capital. Includes incurred fees and available unrealized PnL. Unavailable when the current mark is missing.' },
    { label: 'Total net R', value: rValue(stats.totalNetR), context: `${rValue(stats.averageNetR)} average per completed setup`, sign: outcomeClass(stats.totalNetR), help: 'Sum of completed setup net R. Each setup combines net position PnL and original executed gross risk before division. Stop changes do not change the denominator. If a required denominator is invalid, aggregate R is unavailable.' },
    { label: 'Profit factor', value: profitFactor(stats.profitFactor), context: 'Completed setups · after commissions', sign: '', help: 'Positive setup net PnL / absolute negative setup net PnL. ∞ means profits with no net losses. N/A means no nonzero completed outcomes. Losses without profits give 0.' },
    { label: 'Max DD below start', value: percent(equity.maxStartingDeficitPercent), context: equity.maxStartingDeficitUsd === null ? 'No valid M1 equity observations' : `${usd(equity.maxStartingDeficitUsd)} below initial capital`, sign: equity.maxStartingDeficitUsd ? 'negative' : '', help: `Largest observed deficit below the fixed initial balance of ${usd(referenceBalance)}, divided by that balance. Full M1 resolution. Zero if equity never falls below starting capital.${equity.maxStartingDeficitUsd && equity.startingPoint ? ` Observed ${tradingTime(equity.startingPoint.timestamp)}.` : ''}` },
    { label: 'Max DD from peak', value: percent(equity.maxPeakDrawdownPercent), context: peakContext, sign: equity.maxPeakDrawdownPercent ? 'negative' : '', help: `Largest M1 percentage decline from the previous-or-current equity high-water mark, seeded with initial capital. Unavailable if equity reached zero or below. Maximum dollar drawdown: ${usd(ledger.maxDrawdownUsd)}.${equity.peakPoint?.equityUsd != null && equity.peakPoint.drawdownUsd != null ? ` At the percentage maximum, peak equity was ${usd(equity.peakPoint.equityUsd + equity.peakPoint.drawdownUsd)}.` : ''}` },
    { label: 'Win rate', value: percent(stats.winRatePercent), context: `${stats.winningCount} wins / ${stats.losingCount} losses / ${stats.zeroCount} breakevens`, sign: '', help: 'Strictly positive completed setup net PnL / all completed setups. Exactly zero counts in the denominator. Pending, open, partial, rejected and cancelled setups are excluded.' },
  ]
  const secondary = [
    ['Average winner', rValue(stats.averageWinnerR)], ['Average loser', rValue(stats.averageLoserR)],
    ['Largest winner', rValue(stats.largestWinnerR)], ['Largest loser', rValue(stats.largestLoserR)],
    ['Max losing streak', stats.maxLosingStreak === null ? 'N/A' : `${stats.maxLosingStreak} setups`], ['Average holding time', duration(stats.averageHoldingMs)],
    ['Total commissions', usd(stats.totalCommissionUsd)], ['Executed positions', String(rows.filter(row => row.status === 'completed').reduce((sum, row) => sum + row.positions.length, 0))],
  ]
  return <section className="results-workspace" aria-label="Backtest results">
    <header className="results-heading"><div><h2>Backtest results</h2><p className="results-session-context">{state.symbol === '6E' ? 'EURUSD 6E' : 'EURUSD'} <span>· {tradingTime(start)} → {endpoint === null ? 'N/A' : tradingTime(endpoint)}</span><span>· Initial balance {usd(referenceBalance)}</span></p></div>
      <div className="results-actions"><button type="button" className="primary-action" disabled={resumeDisabled} onClick={onResume}>{reviewOnly ? 'Return to charts' : 'Resume Backtest'}</button><button type="button" onClick={onSave}>Save now</button><button type="button" disabled={!state.positions.length && !state.closed.length} onClick={() => downloadJournalCsv(state)}>Export trades</button></div>
    </header>
    <section className="results-primary" aria-label="Primary performance metrics"><dl className="results-primary-metrics">{primary.map(metric => <div key={metric.label}>
      <dt>{metric.label} <Help text={metric.help} /></dt><dd><span className={metric.sign}>{metric.value}</span><small className="results-metric-context">{metric.context}</small></dd>
    </div>)}</dl>
      <div className="results-sample"><span><strong>{stats.count}</strong> completed setups</span><span>{stats.winningCount} wins / {stats.losingCount} losses / {stats.zeroCount} breakevens</span><span>Risk budget <strong>{percent(state.account.maxRiskPercent)}</strong> · {usd(referenceBalance * state.account.maxRiskPercent / 100)} across both positions</span></div>
    </section>
    {unresolved && <p className="results-unfinished" role="status">{state.positions.length} open positions · {state.pending.length} pending entries · {partial} partially completed setups. Equity includes incurred fees and available unrealized PnL; setup statistics include completed setups only. No exits were created when finishing.</p>}
    {ledger.missingCount > 0 && <p className="coverage-warning results-data-notice">{ledger.missingCount} M1 equity observations unavailable because required quotes were missing. Chart gaps are not interpolated.{ledger.tail?.point.equityUsd === null ? ' Current account return is unavailable.' : ''}</p>}
    {ledger.nonpositiveEquity && <p className="coverage-warning results-data-notice">Equity reached zero or below. Peak percentage drawdown is unavailable; dollar drawdown remains recorded.</p>}
    {stats.validRCount < stats.count && <p className="coverage-warning results-data-notice">{stats.count - stats.validRCount} completed setups have invalid original risk. Aggregate net R is unavailable.</p>}
    <section className="results-analysis" aria-label="Performance charts"><h2 className="results-section-title">Performance charts</h2>
      <ResultsCharts ledger={ledger} positions={positions} referenceBalance={referenceBalance} observations={completed} start={start} endpoint={endpoint} />
    </section>
    <section className="results-secondary" aria-label="Additional statistics"><h2 className="results-section-title">Additional statistics <Help text="Completed setups only. R averages include strictly positive or negative observations. Breakevens end losing streaks. Holding time runs from earliest executed entry to final exit. Commissions here cover completed setups; all incurred entry fees remain in account equity." /></h2>
      <dl>{secondary.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <p className="results-caption">Completed setups only · Net R after commissions · Holding time from earliest entry to final exit</p>
    </section>
    <SetupBreakdown state={state} rows={rows} />
    <details className="results-assumptions"><summary>Execution assumptions and data quality</summary>
      <p>{state.executionModel === 'single-price-m1-v1' ? 'Local EURUSD mid-price M1 model. Simplified next-observed-open fills and high/low stops, with gap-open handling. No spread, slippage, tick order, swaps or financing are modeled.' : singlePrice ? 'Databento 6E single-price M1 model. Hypothetical forex-style sizing and simplified trade-price fills; no synthetic spread.' : 'Legacy EURUSD bid/ask execution. Long positions mark to bid close; short positions mark to ask close.'} Incurred entry and exit commissions are included in account equity; unincurred future exit fees are excluded.</p>
      <p>M1 snapshots cannot reconstruct intraminute or tick-level equity. Missing valuations and clock gaps with exposure break chart lines; confirmed constant values without exposure connect. Drawdown maxima use all {ledger.count.toLocaleString('en-US')} recorded observations before display downsampling. Setup details retain recorded SL coverage warnings.</p>
      <p>Account-equity return can differ from completed-setup realized PnL because open or partial positions and entry fees remain in the ledger. The normal 2% risk budget is combined across both entries. Rounded executed risk determines R; stops never redefine original risk.</p>
      <p>{state.rejected.length} rejected entries · {state.cancelled.length} cancelled entries. Notes, tags and stop history remain in saved records; Export trades preserves the existing position CSV schema.</p>
    </details>
  </section>
})
