import { useState } from 'react'
import { canRequestOrder, formatTradingNumber as number, grossPnl, markPosition, tradingTime, validLots, validStopPrice, stopModificationError, type Position, type Direction, type TradingPermission, type TradingState } from './trading'

interface Props {
  state: TradingState
  permission: TradingPermission
  onEntry: (direction: Direction, lots: number, stopPrice: number) => void
  onCancel: (id: string) => void
  onClose: (id: string) => void
  onModifyStop: (id: string, price: number) => void
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

export function TradingPanel({ state, permission, onEntry, onCancel, onClose, onModifyStop }: Props) {
  const [volume, setVolume] = useState('0.01')
  const [stop, setStop] = useState('')
  const stopPrice = Number(stop)
  const validStop = stop !== '' && validStopPrice(stopPrice)
  const lots = Number(volume)
  const valid = volume !== '' && validLots(lots)
  const slots = state.pending.length + state.positions.length
  const canOrder = canRequestOrder(permission)
  const message = !permission.active ? 'Start Replay to trade.'
    : !permission.hasFuture ? 'End of available history. Remaining positions stay open; unfilled orders stay pending.'
    : permission.playing ? 'Pause replay to place an order or request a close.'
    : slots === 2 ? 'Two position slots in use. Cancel an entry or close a position to free a slot.'
    : 'Orders fill at the next synchronized M1 opening. Resume or step replay to execute.'

  return <section className="trading-panel" aria-label="Simulated trading">
    <div className="trading-controls">
      <h2>Simulated trading</h2>
      <label>Volume (lots)<input type="number" min="0" step="any" value={volume} aria-invalid={!valid}
        aria-describedby={!valid ? 'volume-error' : undefined} onChange={(event) => setVolume(event.target.value)} /></label>
      <label>SL price<input type="number" min="0" step="0.00001" required value={stop} aria-invalid={!validStop}
        aria-describedby={!validStop ? 'entry-stop-error' : undefined} onBlur={() => { if (validStop) setStop(number(stopPrice, 5)) }} onChange={(event) => setStop(event.target.value)} /></label>
      <button type="button" disabled={!canOrder || !valid || !validStop || slots >= 2} onClick={() => onEntry('buy', lots, stopPrice)}>Buy</button>
      <button type="button" disabled={!canOrder || !valid || !validStop || slots >= 2} onClick={() => onEntry('sell', lots, stopPrice)}>Sell</button>
      <span className="trading-slots">{slots} / 2 position slots</span>
    </div>
    {!valid && <p id="volume-error" className="form-error" role="alert">Enter a positive, finite volume in lots.</p>}
    {!validStop && <p id="entry-stop-error" className="form-error">Enter a required positive, finite SL price.</p>}
    <p className="trading-message" role="status">{message}</p>
    <div className="trade-records">
      <section aria-label="Pending orders"><h3>Pending orders ({state.pending.length})</h3>
        {!state.pending.length ? <p>No pending entries.</p> : <ul>{state.pending.map((order) => <li key={order.id} data-order-id={order.id}>
          <strong>Pending entry · {order.direction === 'buy' ? 'Buy' : 'Sell'} · {order.lots} lots</strong>
          <span>ID {order.id} · SL {number(order.stopPrice, 5)}</span>
          <span>Requested {tradingTime(order.requestedAt)}</span>
          <button type="button" aria-label={`Cancel entry ${order.id}`} onClick={() => onCancel(order.id)}>Cancel</button>
        </li>)}</ul>}
        {state.rejected.length > 0 && <><h3>Rejected orders ({state.rejected.length})</h3><ul>{state.rejected.map((order) => <li key={order.id} data-rejected-id={order.id}>
          <strong>Rejected {order.direction === 'buy' ? 'Buy' : 'Sell'} · ID {order.id} · {order.lots} lots</strong>
          <span>{tradingTime(order.rejectedAt)} · {order.reason}</span>
        </li>)}</ul></>}
      </section>
      <section aria-label="Open positions"><h3>Open positions ({state.positions.length})</h3>
        {!state.positions.length ? <p>No open positions.</p> : <ul>{state.positions.map((position) => {
          const mark = markPosition(position, state.quote)
          const pendingClose = position.closeRequestedAt !== null
          return <li key={position.id} data-position-id={position.id}>
            <strong>{pendingClose ? 'Pending close' : 'Open position'} · {position.direction === 'buy' ? 'Buy' : 'Sell'} · {position.lots} lots</strong>
            <span>ID {position.id} · SL {number(position.stopPrice, 5)}</span>
            <span>Entry {tradingTime(position.entryTime)} @ {number(position.entryPrice, 5)}</span>
            <span>Current {mark ? number(mark.price, 5) : 'unavailable'} · Unrealized {mark ? `${number(mark.pips, 1)} pips · $${number(mark.usd, 2)} gross` : 'PnL unavailable'}</span>
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
            <StopRecords position={trade} />
            <span>Realized {number(pnl.pips, 1)} pips · ${number(pnl.usd, 2)} gross</span>
          </li>
        })}</ul>}
      </section>
    </div>
    <p className="trading-note">EURUSD · 1 lot = 100,000 EUR · PnL is gross USD, before commissions, swaps, and financing.</p>
  </section>
}
