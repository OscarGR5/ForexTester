// Synthetic, deterministic data. Never reads the provider, cache or user sessions.
import { createEquityLedger, recordEquity } from '../frontend/src/equity.js'
import type { LoadedHistory } from '../frontend/src/historyLoader.js'
import { defaultWorkspace } from '../frontend/src/uiPreferences.js'
import { equitySummary, type SessionSnapshot } from '../frontend/src/sessionTypes.js'
import { createTradingState, modifyStop, observeCandle, requestClose, requestEntry, updateSetupMetadata } from '../frontend/src/trading.js'
import type { SinglePriceHistory } from '../frontend/src/history.js'

const start = Date.UTC(2024, 0, 1), minute = 60_000
const permission = { active: true, playing: false, hasFuture: true }
export type ResultsFixtureKind = 'populated' | 'empty' | 'unfinished'
export function resultsFixture(kind: ResultsFixtureKind = 'populated', entryDelay = 0) {
  const candles: SinglePriceHistory['candles'] = []
  // Real M1 spacing; synthetic weekday market closures create honest clock gaps.
  for (let timestamp = start - 30 * 86400000; timestamp < Date.UTC(2024, 2, 31); timestamp += minute) {
    const day = new Date(timestamp).getUTCDay()
    if (day === 0 || day === 6) continue
    const index = (timestamp - start) / minute
    const open = Math.round((1.1 + Math.sin(index / 1000) * .003 + Math.sin(index / 110) * .0004) * 100000) / 100000
    const close = Math.round((open + Math.sin(index / 17) * .00005) * 100000) / 100000
    candles.push({ timestamp, open, high: Math.max(open, close) + .00005, low: Math.min(open, close) - .00005, close, volume: '123', instrumentId: 101 })
  }
  const history: LoadedHistory = { priceModel: 'single', source: 'databento', symbol: '6E', dataset: 'GLBX.MDP3', schema: 'ohlcv-1m', continuousSymbol: '6E.v.0', stypeIn: 'continuous', normalizationVersion: 1,
    resolution: 'M1', from: '2023-12-02', to: '2024-03-31', tradingFrom: '2024-01-01', contracts: [{ from: '2023-12-02', to: '2024-03-31', instrumentId: 101, rawSymbol: '6EH4' }], candles }
  const startIndex = candles.findIndex(c => c.timestamp >= start)
  const endIndex = kind === 'unfinished' ? startIndex + 800 : kind === 'empty' ? startIndex + 200 : candles.length - 1
  let state = { ...createTradingState(11, { referenceBalance: 100_000, maxRiskPercent: 2 }, { roundTripUsdPerLot: 7 }), symbol: '6E' as const }
  let ledger = createEquityLedger(100_000)
  for (let index = startIndex; index <= endIndex; index++) {
    const previous = state
    state = { ...observeCandle(state, candles[index], undefined, 'single'), symbol: '6E' }
    ledger = recordEquity(ledger, previous, state)
    if (kind === 'empty') continue
    const offset = index - startIndex - entryDelay
    if (offset < 0) continue
    const cycle = offset % 4320
    if (cycle === 0 && !state.positions.length) {
      const direction = Math.floor(offset / 4320) % 2 ? 'sell' : 'buy'
      const stop = Math.round((candles[index].close + (direction === 'buy' ? -.0043 : .0043)) * 100000) / 100000
      state = { ...requestEntry(state, direction, { mode: 'risk', riskPercent: 1 }, stop, permission), symbol: '6E' }
      const id = state.pending[0].setupId
      state = { ...requestEntry(state, direction, { mode: 'risk', riskPercent: 1 }, stop + (direction === 'buy' ? -.001 : .001), permission, id), symbol: '6E' }
      state = { ...updateSetupMetadata(state, id, { title: `Synthetic setup ${state.setups.length}`, tag: 'Deterministic fixture', notes: '=Stored note remains CSV-safe; this is synthetic data.' }), symbol: '6E' }
    }
    if (cycle === 300 && state.positions.length) {
      const p = state.positions[0]
      state = { ...modifyStop(state, p.id, p.initialStopPrice + (p.direction === 'buy' ? .0002 : -.0002), permission), symbol: '6E' }
    }
    if ((cycle === 600 || cycle === 900) && state.positions.length) state = { ...requestClose(state, state.positions[0].id, permission), symbol: '6E' }
    if (kind === 'unfinished' && index === endIndex) {
      // An independent legacy-compatible pending setup, never filled by finishing.
      const stop = candles[index].close - .004
      state = { ...requestEntry(state, 'buy', { mode: 'risk', riskPercent: .25 }, stop, permission), symbol: '6E' }
    }
  }
  const snapshot: SessionSnapshot = { ledger, checkpoint: { lifecycle: kind === 'unfinished' ? 'trading' : 'finished',
    replay: { started: true, index: endIndex, timestamp: candles[endIndex].timestamp, startIndex, startTimestamp: candles[startIndex].timestamp, speed: 1, complete: endIndex === candles.length - 1, playing: false },
    executionCursor: endIndex + 1, trading: state, equity: equitySummary(ledger),
    // Existing saved position-scope preferences must not affect the dashboard.
    workspace: { ...defaultWorkspace(), statisticsScope: 'positions', journalScope: 'positions' } } }
  return { history, snapshot }
}
