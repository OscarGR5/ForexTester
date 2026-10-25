import type { StopOverlay } from './stopOverlays'
import { observedPrice, quoteCandle } from './trading'
import { useState } from 'react'
import type { useTrading } from './useTrading'
import { activeSetupId, canRequestOrder, entryRequestError, automaticSetupError, stopModificationError, markPosition, combinedRisk, type Direction, type TradingState } from './trading'
import { plannedRisk, sizeFromRisk, type EntrySizing } from './risk'
export interface StopDraft { direction: Direction; sizing: EntrySizing; setupId: string | null; positionId?: string; slot: number; price: number | null }
export function draftObservedPrice(state: TradingState, draft: StopDraft): number | null {
  const price = draft.positionId ? quoteCandle(state.quote, draft.direction === 'buy' ? 'bid' : 'ask')?.close ?? null
    : observedPrice(state.quote, draft.direction)
  return price !== null && Number.isFinite(price) && price > 0 ? price : null
}
export function draftEstimate(state: TradingState, draft: StopDraft) {
  const position = state.positions.find(p => p.id === draft.positionId)
  const price = draftObservedPrice(state, draft)
  const stop = draft.price
  if (!stop || !Number.isFinite(stop) || stop <= 0) return { error: 'Click the price chart to select a stop-loss.', lots: null, risk: null }
  if (price === null) return { error: state.symbol === '6E' ? 'Current trade-price candle unavailable.' : 'Current bid/ask quote unavailable.', lots: null, risk: null }
  const sideError = draft.direction === 'buy' ? stop >= price : stop <= price
  if (!position && sideError) return { error: `${draft.direction === 'buy' ? 'Buy SL must be below' : 'Sell SL must be above'} the observed entry price.`, lots: null, risk: null }
  const lots = position?.lots ?? (typeof draft.sizing === 'number' ? draft.sizing : sizeFromRisk(state.account.referenceBalance * draft.sizing.riskPercent / 100, price, stop))
  const risk = lots === null ? null : plannedRisk({ direction: draft.direction, lots, entryPrice: position?.entryPrice ?? price, stopPrice: stop })
  const error = position ? stopModificationError(state, position, stop, { active: true, playing: false, hasFuture: true })
    : entryRequestError(state, draft.sizing, stop) ?? automaticSetupError(state, draft.direction, draft.setupId) ??
      (!lots ? 'The selected risk rounds below the minimum lot size.' : risk! > combinedRisk(state).remainingUsd + 1e-7 ? 'Estimated risk exceeds the remaining combined risk budget.' : null)
  return { error, lots, risk }
}
export function TradingDock({ reviewing = false, trading, draft, setDraft, stops, onConfirm }: { reviewing?: boolean; onConfirm: () => void; stops: StopOverlay[]; trading: ReturnType<typeof useTrading>; draft: StopDraft | null; setDraft: (draft: StopDraft | null) => void }) {
  const { state, permission } = trading
  const [risk, setRisk] = useState('1')
  const canOrder = canRequestOrder(permission), slots = state.pending.length + state.positions.length
  const setupId = activeSetupId(state)
  const estimate = draft ? draftEstimate(state, draft) : null
  const begin = (direction: Direction) => setDraft({ direction, sizing: { mode: 'risk', riskPercent: Number(risk) }, setupId, slot: slots + 1, price: null })
  return <section className="trading-toolbar" aria-label="Simulated trading">
    <div className="dock-controls">
      <label>Risk (%)<input aria-label="Risk per entry (%)" type="number" min="0" max="100" step="any" value={risk} onChange={e=>setRisk(e.target.value)} disabled={!!draft}/></label>

      <button className="buy-button" disabled={!canOrder || slots >= 2 || !!automaticSetupError(state,'buy',setupId)} onClick={()=>begin('buy')}>Buy</button>
      <button className="sell-button" disabled={!canOrder || slots >= 2 || !!automaticSetupError(state,'sell',setupId)} onClick={()=>begin('sell')}>Sell</button>
      <span>{slots} / 2 slots</span>
    {!reviewing && slots > 0 && <div className="active-positions" role="region" aria-label="Pending and open positions" tabIndex={0}>
      {stops.map(stop => {
        const position = state.positions.find(p => p.id === stop.id)
        const pending = state.pending.find(p => p.id === stop.id)
        const entry = position ?? pending
        if (!entry) return null
        const identity = `${entry.direction === 'buy' ? 'B' : 'S'}${stop.number}`
        const mark = position ? markPosition(position, state.quote) : null
        return <div key={entry.id} data-setup-id={entry.setupId} data-position-id={position?.id} data-order-id={pending?.id}>
          <strong className={entry.direction === 'buy' ? 'entry-buy' : 'entry-sell'}>{pending ? 'Pending ' : ''}{identity}</strong>
          <span>{position ? `${position.lots} lots` : entry.mode === 'risk' ? `${entry.requestedRiskPercent}% risk` : `${entry.lots} lots`}</span>
          {position && <span className={mark ? mark.estimatedNetPnlUsd < 0 ? 'negative' : 'positive' : ''}>{mark ? `Est. net ${mark.estimatedNetPnlUsd < 0 ? '-' : ''}$${Math.abs(mark.estimatedNetPnlUsd).toFixed(2)} (${(mark.estimatedNetPnlUsd/state.account.referenceBalance*100).toFixed(2)}%)` : 'PnL unavailable'}</span>}
          {pending ? <button disabled={!canOrder} onClick={()=>trading.cancel(entry.id)} aria-label={`Cancel entry ${entry.id}`}>Cancel</button> : <>
            <button disabled={!canOrder || position!.closeRequestedAt !== null} onClick={()=>trading.close(entry.id)} aria-label={`Close ${entry.id}`}>{position!.closeRequestedAt !== null ? 'Close pending' : 'Close'}</button>
          </>}
        </div>
      })}
    </div>}
    {(permission.playing || !permission.hasFuture) && <span className="trading-message">{permission.playing ? 'Pause to trade' : 'End of history; positions remain open'}</span>}
    </div>
    {draft && <div className="stop-placement" role="region" aria-label="Place stop-loss">
      <strong>{draft.positionId ? `Modify SL ${draft.positionId}` : `${draft.direction === 'buy' ? 'Buy' : 'Sell'} · slot ${draft.slot}`} · {draft.price === null ? 'Click the price chart to place SL' : `SL ${draft.price.toFixed(5)}`}</strong>
      {estimate?.error ? <span className="form-error" role="status">{estimate.error}</span> : <span>{draft.positionId ? 'Position risk preview:' : 'Observed-price estimate:'} {estimate?.lots?.toFixed(2)} lots · ${estimate?.risk?.toFixed(2)} risk ({((estimate?.risk ?? 0)/state.account.referenceBalance*100).toFixed(2)}%). {draft.positionId ? 'Effective after the current M1 candle.' : 'Final size checked at entry.'}</span>}
      <button disabled={!canOrder || !!estimate?.error} onClick={onConfirm}>{draft.positionId ? 'Confirm SL change' : 'Confirm order'}</button>
      <button onClick={()=>setDraft(null)}>Cancel placement</button>
      <details><summary>Enter price with keyboard</summary><label>SL price<input aria-label="SL price" type="number" step="0.00001" value={draft.price ?? ''} onChange={e=>setDraft({...draft,price:e.target.value ? Number(e.target.value) : null})}/></label></details>
    </div>}
    {!reviewing && state.rejected.at(-1)?.rejectedAt === state.observedTimestamp && <p className="form-error" role="alert">Entry rejected: {state.rejected.at(-1)?.reason}</p>}
  </section>
}
