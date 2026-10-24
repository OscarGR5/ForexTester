// Deterministic offline fixtures shared by persistence tests and measurements.
import { createEquityLedger, recordEquity, type EquityLedger } from './equity.js'
import { defaultIndicatorSettings } from './indicators.js'
import type { LoadedHistory } from './historyLoader.js'
import { createTradingState, observeCandle, type TradingState } from './trading.js'
import { equitySummary, type SessionSnapshot } from './sessionTypes.js'
export const FIXTURE_START = Date.UTC(2024, 0, 1)
export function sessionHistory(count = 200): LoadedHistory {
  const bid = Array.from({ length: count }, (_, i) => ({ timestamp: FIXTURE_START + i * 60_000, open: 1.1 + i % 10 * .00001, high: 1.1008, low: 1.0995, close: 1.1001 }))
  return { symbol: 'EURUSD', resolution: 'M1', from: '2023-12-02', to: '2024-03-31', tradingFrom: '2024-01-01', bid,
    ask: bid.map((bar) => ({ ...bar, open: bar.open + .0002, high: bar.high + .0002, low: bar.low + .0002, close: bar.close + .0002 })) }
}
export const manualPermission = { active: true, playing: false, hasFuture: true }
export function sessionSimulation(history = sessionHistory()) {
  const asks = new Map(history.ask.map((bar) => [bar.timestamp, bar]))
  let state: TradingState = createTradingState(7, { referenceBalance: 10_000, maxRiskPercent: 20 }, { roundTripUsdPerLot: 7 })
  let ledger: EquityLedger = createEquityLedger(10_000), index = -1
  const observe = (next = index + 1) => {
    for (; index < next;) {
      index++
      const previous = state
      state = observeCandle(state, history.bid[index], asks.get(history.bid[index].timestamp))
      ledger = recordEquity(ledger, previous, state)
    }
  }
  const snapshot = (playing = false, speed: 1 | 10 | 100 = 1): SessionSnapshot => ({ ledger, checkpoint: {
    lifecycle: index < 0 ? 'setup' : index === history.bid.length - 1 ? 'finished' : 'trading',
    replay: { started: index >= 0, index: index >= 0 ? index : null, timestamp: index >= 0 ? history.bid[index].timestamp : null,
      startIndex: 0, startTimestamp: FIXTURE_START, speed, complete: index === history.bid.length - 1, playing: playing && index < history.bid.length - 1 },
    executionCursor: index + 1, trading: state, equity: equitySummary(ledger),
    workspace: { chartCount: 3, timeframes: ['M1', 'M5', 'H4'], indicators: [ { M1: defaultIndicatorSettings() }, { M5: defaultIndicatorSettings() }, { H4: defaultIndicatorSettings() } ],
      statisticsScope: 'positions', journalScope: 'positions', viewport: { range: { from: FIXTURE_START / 1000, to: FIXTURE_START / 1000 + 3600 }, following: false } },
  } })
  return { history, observe, snapshot, get state() { return state }, set state(value: TradingState) { state = value }, get ledger() { return ledger } }
}
