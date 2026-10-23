import { useState } from 'react'
import { commissionConfigError, perSideCommissionUsd, type CommissionConfig } from './commissions'
import { accountRiskError, plannedRisk, riskBudget, sizeFromRisk, validRiskPercent, type AccountRisk, type EntrySizing } from './risk'
import { combinedRisk, entryRequestError, canRequestOrder, formatTradingNumber as number, grossPnl, markPosition, realizedSummary, stopLossEstimates, tradingTime, validLots, validStopPrice, stopModificationError, type PendingEntry, type Position, type Direction, type TradingPermission, type TradingState } from './trading'

interface Props {
  state: TradingState
  permission: TradingPermission
  onEntry: (direction: Direction, sizing: EntrySizing, stopPrice: number) => void
  onConfigure: (account: AccountRisk) => void
  onConfigureCommission: (commission: CommissionConfig) => void
  onCancel: (id: string) => void
  onClose: (id: string) => void
  onModifyStop: (id: string, price: number) => void
}

function PendingManualRisk({ order, state }: { order: PendingEntry; state: TradingState }) {
  if (order.mode !== 'manual') return null
  const quote = state.quote?.bid && state.quote.ask ? state.quote[order.direction === 'buy' ? 'ask' : 'bid']!.close : null
  const validSide = quote !== null && (order.direction === 'buy' ? order.stopPrice < quote : order.stopPrice > quote)
  const usd = validSide ? plannedRisk({ ...order, entryPrice: quote, lots: order.lots! }) : null
  return <span>Estimated risk: {usd === null || !Number.isFinite(usd) ? 'unavailable' : `$${number(usd, 2)} USD (${number(usd / state.account.referenceBalance * 100, 2)}%)`} · Unreserved; actual cap checked at execution.</span>
}

function StopRecords({ position }: { position: Position }) {
  return <>
    {position.stopModifications.map((change, index) => <span key={index}>SL changed {tradingTime(change.timestamp)}: {number(change.oldPrice, 5)} → {number(change.newPrice, 5)}</span>)}
    {position.coverageWarnings.map((warning, index) => <span className="coverage-warning" key={index}>SL coverage uncertain: {warning.side} {warning.reason === 'clock_gap' ? 'clock gap' : 'quote unavailable'} from {tradingTime(warning.from)} through {tradingTime(warning.to)}. No fill inferred during this interval.</span>)}
  </>
}

function StopEditor({ state, position, permission, onModify }: { state: TradingState; position: Position; permission: TradingPermission; onModify: (id: string, price: number) => void }) {
  const [value, setValue] = useState(number(position.stopPrice, 5))
  const price = Number(value)
  const error = stopModificationError(state, position, price, permission)
  const errorId = `stop-error-${position.id}`
  return <div className="stop-editor">
    <label>Replacement SL<input aria-label={`Replacement SL ${position.id}`} type="number" min="0" step="0.00001" value={value}
      disabled={!canRequestOrder(permission)} aria-invalid={!!error} aria-describedby={error ? errorId : undefined}
      onBlur={() => { if (validStopPrice(price)) setValue(number(price, 5)) }} onChange={(event) => setValue(event.target.value)} /></label>
    <button type="button" aria-label={`Update SL ${position.id}`} disabled={!!error || price === position.stopPrice} onClick={() => onModify(position.id, price)}>Update SL</button>
    {error && <p className="form-error" id={errorId}>{error}</p>}
    <span>Changes apply from the next available M1 candle.</span>
  </div>
}

export function TradingPanel({ state, permission, onEntry, onConfigure, onConfigureCommission, onCancel, onClose, onModifyStop }: Props) {
  const [commissionError, setCommissionError] = useState<string | null>(null)
  const summary = realizedSummary(state.closed)
  const [mode, setMode] = useState<'risk' | 'manual'>('risk')
  const [risk, setRisk] = useState('1')
  const [volume, setVolume] = useState('0.01')
  const [stop, setStop] = useState('')
  const stopPrice = Number(stop)
  const validStop = stop !== '' && validStopPrice(stopPrice)
  const lots = Number(volume)
  const validVolume = volume !== '' && validLots(lots)
  const sizing: EntrySizing = mode === 'risk' ? { mode: 'risk', riskPercent: Number(risk) } : lots
  const valid = mode === 'risk' ? validRiskPercent(Number(risk)) : validVolume
  const entryError = entryRequestError(state, sizing, stopPrice)
  const accountError = accountRiskError(state.account)
  const exposure = combinedRisk(state)
  const budget = riskBudget(state.account.referenceBalance, Number(risk))
  const slots = state.pending.length + state.positions.length
  const canOrder = canRequestOrder(permission)
  const message = !permission.active ? 'Start Replay to trade.'
    : !permission.hasFuture ? 'End of available history. Remaining positions stay open; unfilled orders stay pending.'
    : permission.playing ? 'Pause replay to place an order or request a close.'
    : slots === 2 ? 'Two position slots in use. Cancel an entry or close a position to free a slot.'
    : 'Orders fill at the next synchronized M1 opening. Resume or step replay to execute.'

  return <section className="trading-panel" aria-label="Simulated trading">
    <h2>Simulated trading</h2>
    <fieldset className="account-risk"><legend>Account settings · USD</legend>
      <label>Reference balance (USD)<input aria-label="Reference balance (USD)" type="number" min="0" step="any"
        value={state.account.referenceBalance || ''} disabled={permission.active} aria-invalid={!!accountError}
        onChange={(event) => onConfigure({ ...state.account, referenceBalance: Number(event.target.value) })} /></label>
      <label>Maximum combined gross planned risk (%)<input aria-label="Maximum combined gross planned risk (%)" type="number" min="0" max="100" step="any"
        value={state.account.maxRiskPercent || ''} disabled={permission.active} aria-invalid={!!accountError}
        onChange={(event) => onConfigure({ ...state.account, maxRiskPercent: Number(event.target.value) })} /></label>
      <label>Round-trip commission (USD per standard lot)<input aria-label="Round-trip commission (USD per standard lot)" type="number" min="0" step="any"
        value={state.commission.roundTripUsdPerLot} disabled={permission.active} aria-invalid={!!commissionError} aria-describedby="commission-help"
        onChange={(event) => {
          const config = { roundTripUsdPerLot: event.target.value === '' ? NaN : Number(event.target.value) }
          const error = commissionConfigError(config)
          setCommissionError(error)
          if (!error) onConfigureCommission(config)
        }} /></label>
      {commissionError && <p className="form-error" role="alert">{commissionError} Previous valid rate retained.</p>}
      <p className="risk-totals" aria-label="Combined risk" aria-live="polite">
        Maximum ${number(exposure.maximumUsd, 2)} USD · Current planned ${number(exposure.openUsd, 2)} USD ({number(exposure.openUsd / state.account.referenceBalance * 100 || 0, 2)}%)<br />
        Reserved ${number(exposure.reservedUsd, 2)} USD · Remaining ${number(exposure.remainingUsd, 2)} USD
      </p>
      <span>Fixed sizing reference, not account equity. Settings lock during replay. The gross planned risk cap excludes commissions and does not resize lots for fees.</span>
      <span id="commission-help">User-entered USD rate, half charged at entry and half at exit. Zero is allowed. No account-currency conversion.</span>
    </fieldset>
    {accountError && <p className="form-error" role="alert">{accountError}</p>}
    <div className="trading-controls">
      <label>Sizing mode<select aria-label="Sizing mode" value={mode} onChange={(event) => setMode(event.target.value as 'risk' | 'manual')}>
        <option value="risk">Risk %</option><option value="manual">Manual Lots</option>
      </select></label>
      {mode === 'risk' ? <label>Risk per entry (%)<input aria-label="Risk per entry (%)" type="number" min="0" max="100" step="any" value={risk}
        disabled={permission.active && !canOrder} aria-invalid={!valid} aria-describedby={entryError ? 'entry-error' : undefined} onChange={(event) => setRisk(event.target.value)} /></label>
        : <label>Volume (lots)<input type="number" min="0" step="any" value={volume} aria-invalid={!valid}
        aria-describedby={entryError ? 'entry-error' : undefined} onChange={(event) => setVolume(event.target.value)} /></label>}
      <label>SL price<input type="number" min="0" step="0.00001" required value={stop} aria-invalid={!validStop}
        aria-describedby={entryError ? 'entry-error' : undefined} onBlur={() => { if (validStop) setStop(number(stopPrice, 5)) }} onChange={(event) => setStop(event.target.value)} /></label>
      <button type="button" disabled={!canOrder || !!entryError || slots >= 2} onClick={() => onEntry('buy', sizing, stopPrice)}>Buy</button>
      <button type="button" disabled={!canOrder || !!entryError || slots >= 2} onClick={() => onEntry('sell', sizing, stopPrice)}>Sell</button>
      <span className="trading-slots">{slots} / 2 position slots</span>
    </div>
    {entryError && <p id="entry-error" className="form-error">{entryError}</p>}
    <p className="trading-message" role="status">{message}</p>
    <div className="entry-estimates" aria-label="Entry estimates">
      {(['buy', 'sell'] as const).map((direction) => {
        const price = state.quote?.bid && state.quote.ask ? state.quote[direction === 'buy' ? 'ask' : 'bid']!.close : null
        const validSide = price !== null && validStop && (direction === 'buy' ? stopPrice < price : stopPrice > price)
        const estimateLots = validSide && valid ? mode === 'risk' ? sizeFromRisk(budget, price, stopPrice) : lots : null
        const estimateRisk = estimateLots === null || price === null ? null : plannedRisk({ direction, lots: estimateLots, entryPrice: price, stopPrice })
        return <span key={direction}>{direction === 'buy' ? 'Buy' : 'Sell'} estimate: {estimateLots === null || estimateRisk === null || !Number.isFinite(estimateRisk) ? 'unavailable' : `${number(estimateLots, mode === 'risk' ? 2 : 4)} lots · $${number(estimateRisk, 2)} USD (${number(estimateRisk / state.account.referenceBalance * 100, 2)}%)`}</span>
      })}
      <span>Estimates use observed closing quotes. Actual risk-based size is determined from the future execution opening. Manual lots are never resized.</span>
    </div>
    <p className="realized-summary" aria-label="Realized summary" aria-live="polite">
      {summary.count} closed positions · Gross realized ${number(summary.grossPnlUsd, 2)} USD · Realized commissions ${number(summary.totalCommissionUsd, 2)} USD · Net realized ${number(summary.netPnlUsd, 2)} USD
    </p>
    <div className="trade-records">
      <section aria-label="Pending orders"><h3>Pending orders ({state.pending.length})</h3>
        {!state.pending.length ? <p>No pending entries.</p> : <ul>{state.pending.map((order) => <li key={order.id} data-order-id={order.id}>
          <strong>Pending entry · {order.direction === 'buy' ? 'Buy' : 'Sell'} · {order.mode === 'risk' ? `${order.requestedRiskPercent}% risk · $${number(order.requestedRiskUsd!, 2)} USD allocation` : `${order.lots} lots`}</strong>
          <span>ID {order.id} · SL {number(order.stopPrice, 5)}</span>
          <span>Requested {tradingTime(order.requestedAt)}</span>
          <PendingManualRisk order={order} state={state} />
          <button type="button" aria-label={`Cancel entry ${order.id}`} onClick={() => onCancel(order.id)}>Cancel</button>
        </li>)}</ul>}
        {state.rejected.length > 0 && <><h3>Rejected orders ({state.rejected.length})</h3><ul>{state.rejected.map((order) => <li key={order.id} data-rejected-id={order.id}>
          <strong>Rejected {order.direction === 'buy' ? 'Buy' : 'Sell'} · ID {order.id} · {order.mode === 'risk' ? `${order.requestedRiskPercent}% risk · $${number(order.requestedRiskUsd!, 2)} USD allocation` : `${order.lots} lots`}</strong>
          <span>{tradingTime(order.rejectedAt)} · {order.reason}</span>
        </li>)}</ul></>}
      </section>
      <section aria-label="Open positions"><h3>Open positions ({state.positions.length})</h3>
        {!state.positions.length ? <p>No open positions.</p> : <ul>{state.positions.map((position) => {
          const mark = markPosition(position, state.quote)
          const stopLoss = stopLossEstimates(position)
          const estimatedExitCommission = perSideCommissionUsd(position.lots, position.commission)
          const pendingClose = position.closeRequestedAt !== null
          return <li key={position.id} data-position-id={position.id}>
            <strong>{pendingClose ? 'Pending close' : 'Open position'} · {position.direction === 'buy' ? 'Buy' : 'Sell'} · {position.lots} lots</strong>
            <span>ID {position.id} · SL {number(position.stopPrice, 5)}</span>
            <span>Entry {tradingTime(position.entryTime)} @ {number(position.entryPrice, 5)}</span>
            <span>Original planned risk ${number(position.initialRiskUsd, 2)} USD ({number(position.initialRiskPercent, 2)}%) · Current planned risk ${number(plannedRisk(position), 2)} USD</span>
            <span>Current {mark ? number(mark.price, 5) : 'unavailable'} · Unrealized {mark ? `${number(mark.pips, 1)} pips · $${number(mark.usd, 2)} gross` : 'PnL unavailable'}</span>
            <span>Entry commission (incurred) ${number(position.entryCommissionUsd, 2)} USD · Estimated exit commission ${number(estimatedExitCommission, 2)} USD</span>
            <span>Estimated net PnL (mark-to-close): {mark ? `$${number(mark.estimatedNetPnlUsd, 2)} USD` : 'unavailable'}</span>
            <span>Estimated total loss at initial SL ${number(stopLoss.initialLossUsd, 2)} USD · Estimated total downside at current SL ${number(stopLoss.currentLossUsd, 2)} USD</span>
            {pendingClose && <span>Close requested {tradingTime(position.closeRequestedAt!)}</span>}
            {!permission.hasFuture && <span>Open at end of available history{pendingClose ? '; close unfilled' : ''}.</span>}
            <button type="button" aria-label={`Close position ${position.id}`} disabled={!canOrder || pendingClose} onClick={() => onClose(position.id)}>Close</button>
            <StopEditor key={`${position.id}-${position.stopPrice}`} state={state} position={position} permission={permission} onModify={onModifyStop} />
            <StopRecords position={position} />
          </li>
        })}</ul>}
      </section>
      <section aria-label="Closed trades"><h3>Closed trades ({state.closed.length})</h3>
        {!state.closed.length ? <p>No closed trades.</p> : <ul>{state.closed.map((trade) => {
          const pnl = grossPnl(trade, trade.exitPrice)
          return <li key={trade.id} data-trade-id={trade.id}>
            <strong>Closed position · {trade.direction === 'buy' ? 'Buy' : 'Sell'} · {trade.lots} lots</strong>
            <span>ID {trade.id} · SL {number(trade.stopPrice, 5)}</span>
            <span>Entry {tradingTime(trade.entryTime)} @ {number(trade.entryPrice, 5)}</span>
            <span>Exit {tradingTime(trade.exitTime)} @ {number(trade.exitPrice, 5)}</span>
            <span>{trade.exitReason === 'stop_loss' ? `Stop loss · ${trade.stopFillType === 'gap_open' ? 'gap-through opening fill' : 'level fill'}` : 'Manual exit'} · Triggering M1 candle timestamp; intraminute time unknown.</span>
            <span>Original planned risk ${number(trade.initialRiskUsd, 2)} USD ({number(trade.initialRiskPercent, 2)}%)</span>
            <StopRecords position={trade} />
            <span>Realized {number(pnl.pips, 1)} pips · ${number(trade.grossPnlUsd, 2)} gross</span>
            <span>Entry commission ${number(trade.entryCommissionUsd, 2)} USD · Exit commission ${number(trade.exitCommissionUsd, 2)} USD · Total commission ${number(trade.totalCommissionUsd, 2)} USD</span>
            <strong>Net realized PnL ${number(trade.netPnlUsd, 2)} USD</strong>
          </li>
        })}</ul>}
      </section>
    </div>
    <p className="trading-note">EURUSD · 1 lot = 100,000 EUR · Planned SL exposure is not a guaranteed maximum loss. SL estimates include entry and expected exit commissions and assume a normal fill at the SL level. Gaps may increase losses; slippage is not modeled. Sizing and the gross risk cap exclude fees. Historical bid/ask fills already include spread; only commission is subtracted from gross PnL. Swaps and financing are not modeled.</p>
  </section>
}
