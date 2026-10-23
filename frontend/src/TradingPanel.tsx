import { useState } from 'react'
import { canRequestOrder, formatTradingNumber as number, grossPnl, markPosition, tradingTime, validLots, type Direction, type TradingPermission, type TradingState } from './trading'

interface Props {
  state: TradingState
  permission: TradingPermission
  onEntry: (direction: Direction, lots: number) => void
  onCancel: (id: string) => void
  onClose: (id: string) => void
}

export function TradingPanel({ state, permission, onEntry, onCancel, onClose }: Props) {
  const [volume, setVolume] = useState('0.01')
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
      <button type="button" disabled={!canOrder || !valid || slots >= 2} onClick={() => onEntry('buy', lots)}>Buy</button>
      <button type="button" disabled={!canOrder || !valid || slots >= 2} onClick={() => onEntry('sell', lots)}>Sell</button>
      <span className="trading-slots">{slots} / 2 position slots</span>
    </div>
    {!valid && <p id="volume-error" className="form-error" role="alert">Enter a positive, finite volume in lots.</p>}
    <p className="trading-message" role="status">{message}</p>
    <div className="trade-records">
      <section aria-label="Pending orders"><h3>Pending orders ({state.pending.length})</h3>
        {!state.pending.length ? <p>No pending entries.</p> : <ul>{state.pending.map((order) => <li key={order.id} data-order-id={order.id}>
          <strong>Pending entry · {order.direction === 'buy' ? 'Buy' : 'Sell'} · {order.lots} lots</strong>
          <span>Requested {tradingTime(order.requestedAt)}</span>
          <button type="button" aria-label={`Cancel entry ${order.id}`} onClick={() => onCancel(order.id)}>Cancel</button>
        </li>)}</ul>}
      </section>
      <section aria-label="Open positions"><h3>Open positions ({state.positions.length})</h3>
        {!state.positions.length ? <p>No open positions.</p> : <ul>{state.positions.map((position) => {
          const mark = markPosition(position, state.quote)
          const pendingClose = position.closeRequestedAt !== null
          return <li key={position.id} data-position-id={position.id}>
            <strong>{pendingClose ? 'Pending close' : 'Open position'} · {position.direction === 'buy' ? 'Buy' : 'Sell'} · {position.lots} lots</strong>
            <span>Entry {tradingTime(position.entryTime)} @ {number(position.entryPrice, 5)}</span>
            <span>Current {mark ? number(mark.price, 5) : 'unavailable'} · Unrealized {mark ? `${number(mark.pips, 1)} pips · $${number(mark.usd, 2)} gross` : 'PnL unavailable'}</span>
            {pendingClose && <span>Close requested {tradingTime(position.closeRequestedAt!)}</span>}
            {!permission.hasFuture && <span>Open at end of available history{pendingClose ? '; close unfilled' : ''}.</span>}
            <button type="button" aria-label={`Close position ${position.id}`} disabled={!canOrder || pendingClose} onClick={() => onClose(position.id)}>Close</button>
          </li>
        })}</ul>}
      </section>
      <section aria-label="Closed trades"><h3>Closed trades ({state.closed.length})</h3>
        {!state.closed.length ? <p>No closed trades.</p> : <ul>{state.closed.map((trade) => {
          const pnl = grossPnl(trade, trade.exitPrice)
          return <li key={trade.id} data-trade-id={trade.id}>
            <strong>Closed position · {trade.direction === 'buy' ? 'Buy' : 'Sell'} · {trade.lots} lots</strong>
            <span>Entry {tradingTime(trade.entryTime)} @ {number(trade.entryPrice, 5)}</span>
            <span>Exit {tradingTime(trade.exitTime)} @ {number(trade.exitPrice, 5)}</span>
            <span>Realized {number(pnl.pips, 1)} pips · ${number(pnl.usd, 2)} gross</span>
          </li>
        })}</ul>}
      </section>
    </div>
    <p className="trading-note">EURUSD · 1 lot = 100,000 EUR · PnL is gross USD, before commissions, swaps, and financing.</p>
  </section>
}
