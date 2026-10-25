import { perSideCommissionUsd } from './commissions'
import { sizeFromRisk } from './risk'
import { formatTradingNumber, grossPnl, observedPrice, type TradingState } from './trading'
import type { StopPreview } from './useStopDrag'

export const STOP_COLOR = '#ef9a9a'
export interface StopOverlay {
  id: string
  number: number
  price: number
  pending: boolean
  pips: number | null
  netUsd: number | null
  label: string
  annotation: string
}

// Presentation only. Pending estimates use the observed quote, never future bars.
// Include resolved entries in the setup's original submission order, so removing
// SL 1 cannot renumber SL 2. Existing IDs survive fill, close, cancel and restore.
export function stopOverlays(state: Pick<TradingState, 'positions' | 'pending' | 'closed' | 'cancelled' | 'rejected' | 'quote' | 'commission'>, preview?: StopPreview | null): StopOverlay[] {
  const entries = [...state.positions, ...state.pending, ...state.closed, ...state.cancelled, ...state.rejected]
  const entryOrder = (id: string) => Number(id.split('-').at(-1))
  return [...state.positions, ...state.pending]
    .sort((a, b) => entryOrder(a.id) - entryOrder(b.id))
    .map((entry) => {
      const number = entries.filter(other => other.setupId === entry.setupId && entryOrder(other.id) < entryOrder(entry.id)).length + 1
      const position = state.positions.find(position => position.id === entry.id)
      const pending = !position
      const price = !pending && preview?.id === entry.id ? preview.price : entry.stopPrice
      const entryPrice = position?.entryPrice ?? observedPrice(state.quote, entry.direction)
      const validSide = entryPrice !== null && (entry.direction === 'buy' ? price < entryPrice : price > entryPrice)
      const lots = position ? position.lots : entry.mode === 'manual' ? entry.lots
        : validSide ? sizeFromRisk(entry.requestedRiskUsd!, entryPrice!, price) : null
      const outcome = entryPrice !== null && lots !== null && (!pending || validSide)
        ? grossPnl({ direction: entry.direction, lots, entryPrice }, price) : null
      const commission = position?.commission ?? state.commission
      const fees = lots === null ? 0 : (position?.entryCommissionUsd ?? perSideCommissionUsd(lots, commission)) + perSideCommissionUsd(lots, commission)
      const pips = outcome ? Math.abs(outcome.pips) : null
      const netUsd = outcome ? outcome.usd - fees : null
      const money = netUsd === null ? null : `${netUsd < 0 ? '-' : netUsd > 0 ? '+' : ''}$${formatTradingNumber(Math.abs(netUsd), 2)}`
      const identity = `${pending ? 'Pending ' : ''}SL ${number}`
      const outcomeText = pips === null ? 'entry pending' : `${pending ? '~' : ''}${formatTradingNumber(pips, 1)} pips · ${pending ? 'est. ' : ''}${money}`
      const label = `${identity} · ${price.toFixed(5)} · ${outcomeText}`
      const annotation = `${identity} · ${outcomeText}`
      return { id: entry.id, number, price, pending, pips, netUsd, label, annotation }
    })
}
