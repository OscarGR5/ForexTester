// Deterministic synthetic sessions through the real execution/ledger code.
// No provider, historical download, or session-storage access.
import { createEquityLedger, recordEquity } from '../frontend/src/equity.js'
import { createTradingState, observeCandle, requestClose, requestEntry } from '../frontend/src/trading.js'

export type BalanceFixtureKind = 'closed' | 'open' | 'missing' | 'empty'
export function balanceEquityFixture(kind: BalanceFixtureKind = 'closed', marketClosure = true) {
  const start = Date.parse('2024-01-05T20:50Z'), monday = Date.parse('2024-01-08T00:00Z')
  const permission = { active: true, playing: false, hasFuture: true }
  let state = createTradingState(1, { referenceBalance: 10000, maxRiskPercent: 100 }, { roundTripUsdPerLot: 7 })
  let ledger = createEquityLedger(10000)
  const end = kind === 'empty' ? 5 : kind === 'missing' ? 16 : kind === 'open' ? 25 : 60
  for (let i = 0; i <= end; i++) {
    const timestamp = !marketClosure || i < 10 ? start + i * 60000 : monday + (i - 10) * 60000
    const price = 1.1 + Math.sin(i / 3) * .002
    const bar = (p: number) => ({ timestamp, open: p, close: p, high: p + .00001, low: p - .00001 })
    const previous = state
    state = observeCandle(state, bar(price), i === 15 || i === 16 ? undefined : bar(price + .0002))
    ledger = recordEquity(ledger, previous, state)
    if (kind === 'empty') continue
    if (i === 0) {
      state = requestEntry(state, 'sell', 1, 1.13, permission)
      state = requestEntry(state, 'sell', .5, 1.13, permission, state.pending[0].setupId)
    }
    if (i === 29 || i === 44) state = requestClose(state, state.positions[0].id, permission)
  }
  return { state, ledger, start, endpoint: state.observedTimestamp }
}
