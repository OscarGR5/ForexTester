import '../backend/src/environment.js'
import { stat, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { IChartApi } from 'lightweight-charts'
import { LocalArchive } from '../backend/src/localArchive.js'
import { diskApiFixture } from '../tests/diskApiFixture.js'
import { automaticReplayStart } from '../frontend/src/cacheCalendar.js'
import { DiskSessionStore } from '../frontend/src/diskSessionStore.js'
import { createEquityLedger, recordEquity } from '../frontend/src/equity.js'
import { EquityDisplay } from '../frontend/src/equityDisplay.js'
import { historyCandles, parseHistory } from '../frontend/src/history.js'
import { IndicatorSeries } from '../frontend/src/indicatorSeries.js'
import { indicatorPreset } from '../frontend/src/indicators.js'
import { ReplayBars } from '../frontend/src/replayBars.js'
import { equitySummary, type SessionSnapshot } from '../frontend/src/sessionTypes.js'
import { historyFingerprint } from '../frontend/src/sessionCodec.js'
import { createTradingState, observeCandle } from '../frontend/src/trading.js'
import { defaultWorkspace } from '../frontend/src/uiPreferences.js'

const tradingFrom = '2025-09-26', to = '2026-09-26'
const measure = async <T>(work: () => Promise<T> | T) => { const started = performance.now(), result = await work(); return { ms: performance.now() - started, result } }
const memory = () => Object.fromEntries(Object.entries(process.memoryUsage()).map(([key, bytes]) => [key, Number((bytes / 1048576).toFixed(2))]))
const sink = () => {
  const operations = { setData: 0, update: 0 }
  const chart = { addSeries: () => ({ applyOptions() {}, setSeriesOrder() {}, setData: () => operations.setData++, update: () => operations.update++, attachPrimitive() {}, detachPrimitive() {}, createPriceLine() {}, priceScale: () => ({ applyOptions() {} }) }),
    panes: () => [{ setStretchFactor() {} }, { setStretchFactor() {} }], removeSeries() {} }
  return { chart: chart as unknown as IChartApi, operations }
}

const archive = new LocalArchive()
await archive.datasets()
const before = memory()
const query = await measure(() => archive.load('EURUSD', tradingFrom, to))
const history = { ...query.result, tradingFrom }
const candles = historyCandles(history)
const response = await measure(() => JSON.stringify(history))
const responseBytes = Buffer.byteLength(response.result)
const jsonParse = await measure(() => JSON.parse(response.result))
const validation = await measure(() => ({ ...parseHistory(jsonParse.result, { from: history.from, to: history.to }), tradingFrom }))
const replay = automaticReplayStart(candles, { from: tradingFrom, to })
if (!replay) throw new Error('Installed history did not provide the required pre-roll.')
const lateIndex = replay.index + Math.floor((candles.length - replay.index - 1) * 0.9)

const chartMeasurements: Record<string, number> = {}
for (const [label, count] of [['initial', replay.index + 1], ['lateRestore', lateIndex + 1]] as const) {
  const started = performance.now()
  for (const timeframe of ['M5', 'H1', 'H4'] as const) {
    const target = sink(), bars = new ReplayBars(timeframe), indicators = new IndicatorSeries(target.chart)
    bars.advance(candles, count)
    indicators.update(bars.candles, indicatorPreset(timeframe), timeframe, true)
  }
  chartMeasurements[`${label}ThreePanesMs`] = performance.now() - started
}

const responsiveness: Record<string, { meanMs: number; maxMs: number }> = {}
for (const speed of [1, 10, 100] as const) {
  const target = sink(), bars = new ReplayBars('M5'), indicators = new IndicatorSeries(target.chart), samples: number[] = []
  let count = replay.index + 1
  bars.advance(candles, count); indicators.update(bars.candles, indicatorPreset('M5'), 'M5', true)
  for (let sample = 0; sample < 100 && count < candles.length; sample++) {
    const started = performance.now(); count = Math.min(candles.length, count + speed)
    bars.advance(candles, count); indicators.update(bars.candles, indicatorPreset('M5'), 'M5', false)
    samples.push(performance.now() - started)
  }
  responsiveness[`${speed}x`] = { meanMs: samples.reduce((sum, value) => sum + value, 0) / samples.length, maxMs: Math.max(...samples) }
}

let state = { ...createTradingState(1), symbol: 'EURUSD' as const, executionModel: 'single-price-m1-v1' as const }
let ledger = createEquityLedger(state.account.referenceBalance)
const storage = await diskApiFixture(), originalFetch = globalThis.fetch
globalThis.fetch = storage.fetch
const client = new DiskSessionStore()
const historyId = await historyFingerprint(history)
const base = { id: crypto.randomUUID(), name: '365-day persistence benchmark', createdAt: new Date().toISOString(), range: { from: tradingFrom, to }, historyId, totalCandles: candles.length }
const cache = await measure(() => client.cacheHistory(historyId, history))
let saved = null as Awaited<ReturnType<DiskSessionStore['save']>> | null
const checkpoints: number[] = [], engineStarted = performance.now()
for (let index = replay.index; index <= lateIndex; index++) {
  const previous = state
  state = observeCandle(state, candles[index], undefined, 'single')
  ledger = recordEquity(ledger, previous, state)
  if (index === replay.index || index === lateIndex || (index - replay.index) % 20_000 === 0) {
    const snapshot: SessionSnapshot = { ledger, checkpoint: { lifecycle: 'trading', replay: { started: true, index, timestamp: candles[index].timestamp,
      startIndex: replay.index, startTimestamp: candles[replay.index].timestamp, speed: 100, complete: false, playing: false }, executionCursor: index + 1,
      trading: state, equity: equitySummary(ledger), workspace: defaultWorkspace() } }
    const checkpoint = await measure(() => client.save(base, snapshot, saved)); saved = checkpoint.result; checkpoints.push(checkpoint.ms)
  }
}
const engineAndCheckpointMs = performance.now() - engineStarted
const restore = await measure(() => client.recover(base.id))
const display = new EquityDisplay(), results = await measure(() => display.update(restore.result.ledger, 1440))
const historyGzipBytes = (await stat(join(storage.directory, 'history', `${historyId}.json.gz`))).size
const report = {
  environment: 'Installed EURUSD Parquet, Node core-path benchmark, real localhost storage API and synced temporary filesystem',
  range: { tradingFrom, through: '2026-09-25', queryFrom: history.from, to }, candles: candles.length, replayStartIndex: replay.index,
  lateIndex, lateProgressPercent: Number(((lateIndex - replay.index) / (candles.length - replay.index - 1) * 100).toFixed(2)),
  backend: { duckDbQueryMs: query.ms, responseBytes, responseMiB: responseBytes / 1048576 },
  frontend: { jsonParseMs: jsonParse.ms, validationMs: validation.ms, ...chartMeasurements, responsiveness,
    equityDisplayMs: results.ms, equityDisplayPoints: results.result.length },
  persistence: { historyUploadMs: cache.ms, historyGzipBytes, checkpointCount: checkpoints.length, engineAndCheckpointMs,
    checkpointMeanMs: checkpoints.reduce((sum, value) => sum + value, 0) / checkpoints.length, checkpointMaxMs: Math.max(...checkpoints),
    restoreMs: restore.ms, restoredEquityCount: restore.result.ledger.count, restoredReplayTimestamp: restore.result.checkpoint.replay.timestamp },
  memoryMiB: { before, after: memory(), peakRss: Number((process.resourceUsage().maxRSS / 1024).toFixed(2)) },
}
await mkdir('docs/365-day-backtests', { recursive: true })
await writeFile('docs/365-day-backtests/node-benchmark.json', JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
globalThis.fetch = originalFetch
await storage.close()
