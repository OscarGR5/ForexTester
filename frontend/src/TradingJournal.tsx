import { memo, Fragment, useMemo, useState } from 'react'
import { completedObservations, executedPositions, isClosed, journalSetups, netR, performanceStats, positionStatus, realizedPerformance, type AnalyticsScope } from './analytics'
import { downloadJournalCsv } from './journalCsv'
import { RealizedChart } from './RealizedChart'
import { formatTradingNumber as number, tradingTime, type Position, type SetupMetadata, type TradingSetup, type TradingState } from './trading'

const money = (value: number | null) => value === null ? 'Unavailable' : `$${number(value, 2)}`
const rValue = (value: number | null) => value === null ? 'Unavailable' : `${number(value, 3)}R`
const time = (value: number | null) => value === null ? '—' : tradingTime(value)

function MetadataEditor({ setup, onChange }: { setup: TradingSetup; onChange: (id: string, metadata: SetupMetadata) => void }) {
  return <fieldset className="setup-metadata"><legend>Setup journal · {setup.id}</legend>
    <label>Setup label / title<input aria-label={`Setup label ${setup.id}`} value={setup.title} onChange={(event) => onChange(setup.id, { ...setup, title: event.target.value })} /></label>
    <label>Strategy / model tag<input aria-label={`Setup tag ${setup.id}`} value={setup.tag} onChange={(event) => onChange(setup.id, { ...setup, tag: event.target.value })} /></label>
    <label className="setup-notes">Notes<textarea aria-label={`Setup notes ${setup.id}`} rows={3} value={setup.notes} onChange={(event) => onChange(setup.id, { ...setup, notes: event.target.value })} /></label>
    <p className="journal-help">Edits are autosaved with this session, including after closure. Export CSV for a separate journal copy.</p>
  </fieldset>
}

function PositionDetails({ position }: { position: Position }) {
  const closed = isClosed(position) ? position : null
  return <article className="position-detail" aria-label={`Position details ${position.id}`}>
    <h4>Position {position.id} · Setup {position.setupId} · {position.direction} · {position.lots} lots · {positionStatus(position)}</h4>
    <p>Entry {tradingTime(position.entryTime)} @ {number(position.entryPrice, 5)}<br />Exit {closed ? `${tradingTime(closed.exitTime)} @ ${number(closed.exitPrice, 5)} · ${closed.exitReason}${closed.stopFillType ? ` · ${closed.stopFillType}` : ''}` : 'Not closed'}</p>
    <p>Original SL {number(position.initialStopPrice, 5)} · Final/current SL {number(position.stopPrice, 5)} · Original gross risk {money(position.initialRiskUsd)} USD<br />
      Entry commission {money(position.entryCommissionUsd)} USD · Exit commission {money(closed?.exitCommissionUsd ?? null)} · Total realized commission {money(closed?.totalCommissionUsd ?? null)}<br />
      Gross realized {money(closed?.grossPnlUsd ?? null)} · Net realized {money(closed?.netPnlUsd ?? null)} · Net R {closed ? rValue(netR(closed.netPnlUsd, closed.initialRiskUsd)) : 'Unavailable'}</p>
    {position.stopModifications.length ? <ul>{position.stopModifications.map((change, index) => <li key={index}>SL changed {tradingTime(change.timestamp)}: {number(change.oldPrice, 5)} → {number(change.newPrice, 5)}</li>)}</ul> : <p>No SL modifications.</p>}
    {position.coverageWarnings.length ? <ul className="coverage-warning">{position.coverageWarnings.map((warning, index) => <li key={index}>SL coverage uncertain: {warning.side} · {warning.reason} · {tradingTime(warning.from)} through {tradingTime(warning.to)}</li>)}</ul> : <p>No recorded coverage warnings.</p>}
  </article>
}

interface JournalProps {
  state: TradingState
  onUpdateSetup: (id: string, metadata: SetupMetadata) => void
  scope?: AnalyticsScope
  view?: AnalyticsScope
  onScopeChange?: (scope: AnalyticsScope) => void
  onViewChange?: (view: AnalyticsScope) => void
}
function TradingJournalView({ state, onUpdateSetup, scope: savedScope, view: savedView, onScopeChange, onViewChange }: JournalProps) {
  const [localScope, setLocalScope] = useState<AnalyticsScope>('setups')
  const [localView, setLocalView] = useState<AnalyticsScope>('setups')
  const scope = savedScope ?? localScope, view = savedView ?? localView
  const setScope = onScopeChange ?? setLocalScope, setView = onViewChange ?? setLocalView
  const [expanded, setExpanded] = useState<string | null>(null)
  const rows = useMemo(() => journalSetups(state), [state.setups, state.pending, state.positions, state.closed])
  const positions = useMemo(() => executedPositions(state), [state.positions, state.closed])
  const observations = useMemo(() => scope === 'setups' ? completedObservations(rows) : state.closed, [scope, rows, state.closed])
  const stats = useMemo(() => performanceStats(observations, state.account.referenceBalance), [observations, state.account.referenceBalance])
  const performance = useMemo(() => realizedPerformance(observations, state.account.referenceBalance), [observations, state.account.referenceBalance])
  const kpis = [
    [scope === 'setups' ? 'Completed setups' : 'Closed positions', String(stats.count)], ['Net realized USD', money(stats.netPnlUsd)],
    ['Gross realized USD', money(stats.grossPnlUsd)], ['Commissions USD', money(stats.totalCommissionUsd)],
    ['Win rate', stats.winRatePercent === null ? 'Unavailable' : `${number(stats.winRatePercent, 2)}%`],
    ['Net winners', String(stats.winningCount)], ['Non-winners', `${stats.nonWinningCount} (${stats.losingCount} losses, ${stats.zeroCount} zero)`],
    ['Profit factor', stats.profitFactor === Infinity ? '∞ (no net losses)' : stats.profitFactor === null ? 'Unavailable' : number(stats.profitFactor, 3)],
  ]
  return <section className="trading-journal" aria-label="Trading Journal">
    <div className="journal-heading"><h2>Trading Journal</h2><button type="button" disabled={!positions.length} onClick={() => downloadJournalCsv(state)}>Export Journal CSV</button></div>
    <p className="session-notice">Trades, setups and notes are included in session checkpoints. Check the last successful save above; CSV exports a separate journal copy.</p>
    <section aria-label="Performance statistics">
      <div className="journal-controls"><h3>Performance by setup / position</h3><label>Statistics scope<select aria-label="Statistics scope" value={scope} onChange={(event) => setScope(event.target.value as AnalyticsScope)}>
        <option value="setups">Completed setups</option><option value="positions">Closed positions</option>
      </select></label></div>
      {!stats.count && <p className="journal-empty">No {scope === 'setups' ? 'completed setups' : 'closed positions'} yet. Pending and open entries do not count.</p>}
      <dl className="journal-kpis">{kpis.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <details className="additional-statistics"><summary>More statistics and calculation conventions</summary>
        <dl className="journal-kpis">
          {[['Average net winner USD', money(stats.averageWinnerUsd)], ['Average net loser USD', money(stats.averageLoserUsd)],
            ['Largest net winner USD', money(stats.largestWinnerUsd)], ['Largest net loser USD', money(stats.largestLoserUsd)],
            ['Average net R', rValue(stats.averageNetR)], ['Total net R (sum of observations)', rValue(stats.totalNetR)],
            ['Average holding duration', stats.averageHoldingMs === null ? 'Unavailable' : `${number(stats.averageHoldingMs / 60_000, 1)} min`],
            ['Net return on fixed reference balance', stats.netReturnPercent === null ? 'Unavailable' : `${number(stats.netReturnPercent, 2)}%`],
          ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
        <p className="journal-help">Net winners ÷ all completed observations gives win rate. Exactly zero is a non-winner. Average loser includes strictly negative outcomes only. Profit factor = positive net PnL ÷ absolute negative net PnL. R uses original gross SL risk; setup R uses combined risk, not an average of position R. R statistics include {stats.validRCount} valid denominators. Setup holding duration runs from earliest entry to final exit.</p>
      </details>
    </section>
    <RealizedChart performance={performance} scope={scope} />
    <div className="journal-controls"><h3>Journal records</h3><label>Journal view<select aria-label="Journal view" value={view} onChange={(event) => setView(event.target.value as AnalyticsScope)}>
      <option value="setups">Setup view</option><option value="positions">Position view</option>
    </select></label></div>
    <p className="journal-help">All timestamps are UTC. Original planned risk includes executed entries only. Incomplete setups show partial realized PnL for closed positions; final setup R remains unavailable.</p>
    {view === 'setups' ? !rows.length ? <p className="journal-empty">No setups yet. Submit an entry to start the journal.</p> :
      <div className="journal-table-scroll" role="region" aria-label="Setup journal table" tabIndex={0}><table>
        <caption>Setups · one trading idea per row</caption><thead><tr>{['Setup / details', 'Label / tag', 'Direction', 'Executed positions', 'Status', 'Earliest entry UTC', 'Final exit UTC', 'Original risk USD', 'Gross realized USD', 'Realized commissions USD', 'Net realized USD', 'Final net R', 'Coverage'].map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{rows.map((row) => <Fragment key={row.setup.id}>
          <tr data-journal-setup-id={row.setup.id}><th scope="row">{row.setup.id}<br /><button type="button" aria-label={`Details for setup ${row.setup.id}`} aria-expanded={expanded === row.setup.id} aria-controls={`journal-${row.setup.id}`} onClick={() => setExpanded(expanded === row.setup.id ? null : row.setup.id)}>Details / notes</button></th>
            <td>{row.setup.title || '—'}<br />{row.setup.tag || '—'}</td><td>{row.setup.direction}</td><td>{row.positions.length}</td><td>{row.status}</td>
            <td>{time(row.entryTime)}</td><td>{time(row.exitTime)}</td><td>{money(row.initialRiskUsd)}</td><td>{money(row.grossPnlUsd)}</td><td>{money(row.totalCommissionUsd)}</td>
            <td>{row.status !== 'completed' && <span className="partial-result">Partial realized PnL<br /></span>}{money(row.netPnlUsd)}</td><td>{rValue(row.netR)}</td><td>{row.coverageUncertain ? 'SL coverage uncertain' : 'No recorded warnings'}</td></tr>
          <tr id={`journal-${row.setup.id}`} hidden={expanded !== row.setup.id}><td colSpan={13}>
            {expanded === row.setup.id && <div className="setup-detail"><MetadataEditor setup={row.setup} onChange={onUpdateSetup} />
              {row.positions.map((position) => <PositionDetails key={position.id} position={position} />)}
              {!row.positions.length && <p>No executed positions. Pending, rejected, and cancelled requests are excluded from completed statistics.</p>}
              {state.pending.filter((entry) => entry.setupId === row.setup.id).map((entry) => <p key={entry.id}>Pending entry {entry.id} · {entry.direction} · {entry.mode === 'manual' ? `${entry.lots} lots` : `${entry.requestedRiskPercent}% risk`} · SL {number(entry.stopPrice, 5)} · Requested {tradingTime(entry.requestedAt)}</p>)}
            </div>}
          </td></tr>
        </Fragment>)}</tbody>
      </table></div>
      : !positions.length ? <p className="journal-empty">No executed positions yet.</p> :
      <div className="journal-table-scroll" role="region" aria-label="Position journal table" tabIndex={0}><table>
        <caption>Executed positions · pending requests excluded</caption><thead><tr>{['Position / details', 'Setup', 'Direction', 'Lots', 'Entry UTC / price', 'Exit UTC / price', 'Original SL', 'Final/current SL', 'Original risk USD', 'Gross realized USD', 'Total realized commissions USD', 'Net realized USD', 'Net R', 'Exit reason', 'Status'].map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{positions.map((position) => {
          const closed = isClosed(position) ? position : null
          return <Fragment key={position.id}><tr data-journal-position-id={position.id}>
            <th scope="row">{position.id}<br /><button type="button" aria-label={`Details for position ${position.id}`} aria-expanded={expanded === position.id} aria-controls={`journal-${position.id}`} onClick={() => setExpanded(expanded === position.id ? null : position.id)}>Details</button></th>
            <td>{position.setupId}</td><td>{position.direction}</td><td>{position.lots}</td><td>{tradingTime(position.entryTime)}<br />{number(position.entryPrice, 5)}</td>
            <td>{closed ? <>{tradingTime(closed.exitTime)}<br />{number(closed.exitPrice, 5)}</> : '—'}</td><td>{number(position.initialStopPrice, 5)}</td><td>{number(position.stopPrice, 5)}</td>
            <td>{money(position.initialRiskUsd)}</td><td>{money(closed?.grossPnlUsd ?? null)}</td><td>{money(closed?.totalCommissionUsd ?? null)}</td><td>{money(closed?.netPnlUsd ?? null)}</td>
            <td>{closed ? rValue(netR(closed.netPnlUsd, closed.initialRiskUsd)) : 'Unavailable'}</td><td>{closed?.exitReason ?? '—'}</td><td>{positionStatus(position)}</td></tr>
            <tr id={`journal-${position.id}`} hidden={expanded !== position.id}><td colSpan={15}>{expanded === position.id && <><PositionDetails position={position} />
              {state.setups.filter((setup) => setup.id === position.setupId).map((setup) => <MetadataEditor key={setup.id} setup={setup} onChange={onUpdateSetup} />)}</>}</td></tr>
          </Fragment>
        })}</tbody>
      </table></div>}
    <details className="journal-requests"><summary>Rejected / cancelled requests ({state.rejected.length + state.cancelled.length})</summary>
      {!state.rejected.length && !state.cancelled.length ? <p>No rejected or cancelled requests.</p> : <ul>
        {state.rejected.map((entry) => <li key={entry.id}>Rejected · {entry.id} · Setup {entry.setupId} · {entry.direction} · Requested {tradingTime(entry.requestedAt)} · Rejected {tradingTime(entry.rejectedAt)} · {entry.reason}</li>)}
        {state.cancelled.map((entry) => <li key={entry.id}>Cancelled · {entry.id} · Setup {entry.setupId} · {entry.direction} · Requested {tradingTime(entry.requestedAt)} · Cancelled {tradingTime(entry.cancelledAt)}</li>)}
      </ul>}
    </details>
  </section>
}

// Price-only observations do not rebuild the journal or its tables.
export const TradingJournal = memo(TradingJournalView, (previous, next) =>
  previous.onUpdateSetup === next.onUpdateSetup && previous.scope === next.scope && previous.view === next.view &&
  previous.onScopeChange === next.onScopeChange && previous.onViewChange === next.onViewChange &&
  (['session', 'account', 'setups', 'pending', 'positions', 'closed', 'rejected', 'cancelled'] as const)
    .every((key) => previous.state[key] === next.state[key]))
