import { observedPrice, quoteCandle } from './trading'
import { useState } from 'react'
import type { useTrading } from './useTrading'
import { activeSetupId, canRequestOrder, entryRequestError, automaticSetupError, stopModificationError, markPosition, combinedRisk, type Direction, type TradingState } from './trading'
import { plannedRisk, sizeFromRisk, type EntrySizing } from './risk'
export interface StopDraft { direction: Direction; sizing: EntrySizing; setupId: string | null; positionId?: string; slot: number; price: number | null }
export function draftEstimate(state: TradingState, draft: StopDraft) {
  const position = state.positions.find(p => p.id === draft.positionId)
  const price = position ? quoteCandle(state.quote, draft.direction === 'buy' ? 'bid' : 'ask')?.close ?? null
    : observedPrice(state.quote, draft.direction)
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
export function TradingDock({ trading, draft, setDraft }: { trading: ReturnType<typeof useTrading>; draft: StopDraft | null; setDraft: (draft: StopDraft | null) => void }) {
  const { state, permission } = trading
  const [mode, setMode] = useState('risk'), [risk, setRisk] = useState('1'), [lots, setLots] = useState('0.01')
  const canOrder = canRequestOrder(permission), slots = state.pending.length + state.positions.length
  const setupId = activeSetupId(state)
  const estimate = draft ? draftEstimate(state, draft) : null
  const begin = (direction: Direction) => setDraft({ direction, sizing: mode === 'risk' ? { mode: 'risk', riskPercent: Number(risk) } : Number(lots), setupId, slot: slots + 1, price: null })
  return <section className="trading-dock" aria-label="Simulated trading">
    {state.symbol === '6E' && <p className="chart-note">6E trade prices · hypothetical forex-style sizing (1 lot = 100,000 EUR). No spread; M1 open fills, high/low stops and gap-open handling. Not exchange-accurate futures or EUR/USD CFD execution.</p>}
    <div className="dock-controls">
      <label>Sizing mode<select aria-label="Sizing mode" value={mode} onChange={e=>setMode(e.target.value)} disabled={!!draft}><option value="risk">Risk %</option><option value="manual">Manual lots</option></select></label>
      {mode === 'risk' ? <label>Risk per entry (%)<input aria-label="Risk per entry (%)" type="number" step="any" value={risk} onChange={e=>setRisk(e.target.value)} disabled={!!draft}/></label> : <label>Volume (lots)<input type="number" step="any" value={lots} onChange={e=>setLots(e.target.value)} disabled={!!draft}/></label>}

      <button className="buy-button" disabled={!canOrder || slots >= 2 || !!automaticSetupError(state,'buy',setupId)} onClick={()=>begin('buy')}>Buy</button>
      <button className="sell-button" disabled={!canOrder || slots >= 2 || !!automaticSetupError(state,'sell',setupId)} onClick={()=>begin('sell')}>Sell</button>
      <span>{slots} / 2 slots</span>
      <span className="trading-message">{permission.playing ? 'Pause to trade' : !permission.hasFuture ? 'End of history; positions remain open' : state.symbol === '6E' ? 'Entries fill at the next eligible M1 opening' : 'Entries fill at the next synchronized M1 opening'}</span>
    </div>
    {draft && <div className="stop-placement" role="region" aria-label="Place stop-loss">
      <strong>{draft.positionId ? `Modify SL ${draft.positionId}` : `${draft.direction === 'buy' ? 'Buy' : 'Sell'} · slot ${draft.slot}`} · {draft.price === null ? 'Click the price chart to place SL' : `SL ${draft.price.toFixed(5)}`}</strong>
      {estimate?.error ? <span className="form-error" role="status">{estimate.error}</span> : <span>{draft.positionId ? 'Position risk preview:' : 'Observed-price estimate:'} {estimate?.lots?.toFixed(2)} lots · ${estimate?.risk?.toFixed(2)} risk ({((estimate?.risk ?? 0)/state.account.referenceBalance*100).toFixed(2)}%). {draft.positionId ? 'Effective after the current M1 candle.' : 'Final size checked at entry.'}</span>}
      <button disabled={!canOrder || !!estimate?.error} onClick={()=>{
        if (!draft.price || !canOrder || draftEstimate(state,draft).error) return
        if (draft.positionId) trading.modifyStop(draft.positionId,draft.price)
        else trading.enterAutomatic(draft.direction,draft.sizing,draft.price)
        setDraft(null)
      }}>{draft.positionId ? 'Confirm SL change' : 'Confirm order'}</button>
      <button onClick={()=>setDraft(null)}>Cancel placement</button>
      {draft.price !== null && <button onClick={()=>setDraft({...draft,price:null})}>Choose another level</button>}
      <details><summary>Enter price with keyboard</summary><label>SL price<input aria-label="SL price" type="number" step="0.00001" value={draft.price ?? ''} onChange={e=>setDraft({...draft,price:e.target.value ? Number(e.target.value) : null})}/></label></details>
    </div>}
    <div className="active-positions">
      {state.pending.map(p=><div key={p.id} data-order-id={p.id}><strong>Pending {p.direction} · {p.id}</strong><span>SL {p.stopPrice.toFixed(5)} · {p.mode === 'risk' ? `${p.requestedRiskPercent}% risk` : `${p.lots} lots`}</span><button disabled={!canOrder} onClick={()=>trading.cancel(p.id)} aria-label={`Cancel entry ${p.id}`}>Cancel entry</button></div>)}
      {state.positions.map((p,i)=>{ const mark=markPosition(p,state.quote); return <div key={p.id} data-position-id={p.id}>
        <strong>{p.direction === 'buy' ? 'Buy' : 'Sell'} · {p.id}</strong><span>{p.lots} lots · SL {p.stopPrice.toFixed(5)}</span><span>{mark ? `Est. net $${mark.estimatedNetPnlUsd.toFixed(2)} (${(mark.estimatedNetPnlUsd/state.account.referenceBalance*100).toFixed(2)}%)` : 'PnL unavailable'}</span>
        <button disabled={!canOrder || p.closeRequestedAt !== null} onClick={()=>setDraft({direction:p.direction,sizing:p.lots,setupId:p.setupId,positionId:p.id,slot:i+1,price:null})} aria-label={`Modify SL ${p.id}`}>Modify SL</button>
        <button disabled={!canOrder || p.closeRequestedAt !== null} onClick={()=>trading.close(p.id)} aria-label={`Close ${p.id}`}>{p.closeRequestedAt !== null ? 'Close pending' : 'Close'}</button>
      </div>})}
    </div>
    {state.rejected.at(-1)?.rejectedAt === state.observedTimestamp && <p className="form-error" role="alert">Entry rejected: {state.rejected.at(-1)?.reason}</p>}
  </section>
}
