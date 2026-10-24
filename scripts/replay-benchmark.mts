// Run: node_modules/.bin/tsx scripts/replay-benchmark.mts
// No live provider or browser required. Measures the production aggregation,
// indicator-series adapter, execution and equity paths, with a minimal chart sink.
import { performance } from 'node:perf_hooks'
import type { IChartApi } from 'lightweight-charts'
import { ReplayBars } from '../frontend/src/replayBars'
import { IndicatorSeries } from '../frontend/src/indicatorSeries'
import { indicatorPreset } from '../frontend/src/indicators'
import { createTradingState, observeCandle, requestEntry } from '../frontend/src/trading'
import { createEquityLedger, recordEquity } from '../frontend/src/equity'
import { downsampleEquity, equityObservations } from '../frontend/src/EquityChart'

function chartSink() {
  const operations = { setData: 0, update: 0 }
  const chart = { addSeries: () => ({ applyOptions() {}, setData: () => operations.setData++, update: () => operations.update++,
    attachPrimitive() {}, detachPrimitive() {}, createPriceLine() {}, priceScale: () => ({ applyOptions() {} }) }),
    panes: () => [{ setStretchFactor() {} }, { setStretchFactor() {} }], removeSeries() {} }
  return { chart: chart as unknown as IChartApi, operations }
}
for (const days of [1, 30, 90]) {
  const count = days * 1440
  const source = Array.from({ length: count + 800 }, (_, index) => ({ timestamp: Date.UTC(2024, 0, 1) + index * 60_000,
    open: 1.1, high: 1.101, low: 1.099, close: 1.1 + Math.sin(index) * 0.0001 }))
  const panes = (['D1', 'M5', 'H1'] as const).map((timeframe) => {
    const sink = chartSink()
    return { timeframe, bars: new ReplayBars(timeframe), indicators: new IndicatorSeries(sink.chart), sink }
  })
  const initial = performance.now()
  for (const pane of panes) { pane.bars.advance(source, count); pane.indicators.update(pane.bars.candles, indicatorPreset(pane.timeframe), pane.timeframe, true) }
  const initialMs = performance.now() - initial
  const beforeSets = panes.reduce((sum, pane) => sum + pane.sink.operations.setData, 0)
  const frames: number[] = []
  for (let frame = 1; frame <= 8; frame++) {
    const start = performance.now()
    for (const pane of panes) {
      pane.bars.advance(source, count + frame * 100)
      pane.indicators.update(pane.bars.candles, indicatorPreset(pane.timeframe), pane.timeframe, false)
    }
    frames.push(performance.now() - start)
  }
  let state = createTradingState(0, undefined, { roundTripUsdPerLot: 7 }), ledger = createEquityLedger(state.account.referenceBalance)
  const execution = performance.now()
  for (let index = 0; index < count; index++) {
    const bid = source[index], ask = { ...bid, open: bid.open + 0.0002, close: bid.close + 0.0002, high: bid.high + 0.0002, low: bid.low + 0.0002 }
    const previous = state; state = observeCandle(state, bid, ask); ledger = recordEquity(ledger, previous, state)
    if (index === 0) state = requestEntry(state, 'buy', 1, 1.09, { active: true, playing: false, hasFuture: true })
  }
  const executionMs = performance.now() - execution
  const display = performance.now(), points = downsampleEquity(equityObservations(ledger), 1440), displayMs = performance.now() - display
  console.log(JSON.stringify({ days, timeframes: panes.map(pane => pane.timeframe), observations: count, initialMs,
    batch100MeanMs: frames.reduce((a, b) => a + b) / frames.length, batch100MaxMs: Math.max(...frames),
    ordinarySetDataCalls: panes.reduce((sum, pane) => sum + pane.sink.operations.setData, 0) - beforeSets,
    executionAndEquityMs: executionMs, equityObservations: ledger.count, displayMs, displayPoints: points.length }))
}
