import '../backend/src/environment.js'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { build, preview } from 'vite'
import { LocalArchive } from '../backend/src/localArchive.js'
import { SessionStorage } from '../backend/src/sessionStorage.js'
import { createApp } from '../backend/src/app.js'
import { DiskSessionStore } from '../frontend/src/diskSessionStore.js'
import { historyFingerprint } from '../frontend/src/sessionCodec.js'
import { createTradingState, observeCandle } from '../frontend/src/trading.js'
import { createEquityLedger, recordEquity } from '../frontend/src/equity.js'
import { equitySummary } from '../frontend/src/sessionTypes.js'
import { defaultWorkspace, selectChartMode, updateActiveChartMode } from '../frontend/src/uiPreferences.js'
import { indicatorPreset } from '../frontend/src/indicatorSettings.js'
import { nextCandleIndex } from '../frontend/src/candleNavigation.js'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core')
const root = resolve(process.env.BENCH_ROOT ?? '.'), output = resolve(process.env.BENCH_OUTPUT ?? '/tmp/forextester-regression-benchmark')
const label = process.env.BENCH_LABEL ?? 'after-off', enabled = process.env.REGRESSION === '1', samples = Number(process.env.SAMPLES ?? 8)
const directory = await mkdtemp(join(tmpdir(), 'forextester-regression-benchmark-'))
const storage = new SessionStorage({ directory }), archive = new LocalArchive(), api = createApp(archive, undefined, storage)
await mkdir(output, { recursive: true })
await new Promise<void>(done => api.listen(0, '127.0.0.1', done))
const apiOrigin = `http://127.0.0.1:${api.address().port}`, nativeFetch = globalThis.fetch
let server: any, browser: any
const instrument = { name: 'regression-benchmark', enforce: 'pre' as const, transform(code: string, path: string) {
  if (path.endsWith('/src/App.tsx')) return code.replace('const pnl = accountPnl', `globalThis.__app = { replay, uiWorkspace${code.includes('const regression =') ? ', regression, regressionAnchor, setRegressionAnchor' : ''} }; const pnl = accountPnl`)
} }
try {
  const history = { ...await archive.load('EURUSD', '2021-12-25', '2022-12-25', '2021-08-27'), tradingFrom: '2021-12-25' }, source = history.candles
  const initial = source.findIndex(c => c.timestamp >= Date.parse('2022-12-07')), startIndex = source.findIndex(c => c.timestamp >= Date.parse(history.tradingFrom))
  let state = { ...createTradingState(7), symbol: 'EURUSD' as const, executionModel: 'single-price-m1-v1' as const }, ledger = createEquityLedger(state.account.referenceBalance)
  for (let i = startIndex; i <= initial; i++) { const before = state; state = observeCandle(state, source[i], undefined, 'single'); ledger = recordEquity(ledger, before, state) }
  let workspace = selectChartMode(defaultWorkspace(), 4)
  const timeframes = ['D1', 'M5', 'H4', 'H1'] as const
  workspace = updateActiveChartMode(workspace, { timeframes: [...timeframes], indicators: timeframes.map(timeframe => ({ [timeframe]: indicatorPreset(timeframe) })) })
  globalThis.fetch = ((path: string, init?: RequestInit) => nativeFetch(`${apiOrigin}${path}`, { ...init, headers: { Origin: apiOrigin, ...init?.headers } })) as typeof fetch
  const client = new DiskSessionStore(), historyId = await historyFingerprint(history)
  await client.cacheHistory(historyId, history)
  const call = client.call.bind(client)
  client.call = (async (path: string, method = 'GET', body: any) => method === 'POST' && path.startsWith('/sessions/') ? storage.save(body.record, body.chunks, body.expectedRevision) : call(path, method, body)) as typeof client.call
  await client.save({ id: crypto.randomUUID(), name: 'Regression benchmark', createdAt: new Date().toISOString(), range: { from: history.tradingFrom, to: history.to }, historyId, totalCandles: source.length }, { ledger, checkpoint: {
    lifecycle: 'trading', replay: { started: true, index: initial, timestamp: source[initial].timestamp, startIndex, startTimestamp: source[startIndex].timestamp, speed: 1, complete: false, playing: false },
    executionCursor: initial + 1, trading: state, equity: equitySummary(ledger), workspace,
  } }, null)
  globalThis.fetch = nativeFetch
  const outDir = join(directory, 'dist')
  await build({ configFile: false, root: join(root, 'frontend'), plugins: [instrument], build: { outDir, emptyOutDir: true, reportCompressedSize: false } })
  server = await preview({ configFile: false, root: join(root, 'frontend'), build: { outDir }, preview: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: apiOrigin } } } })
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/home/admin/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome', headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await context.newPage(), errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort())
  await context.addInitScript(() => {
    globalThis.__name = (target: unknown) => target
    globalThis.__forexReplayPerformance = { samples: {}, counts: {}, latest: {} }
    const begin = (event: Event) => {
      const armed = globalThis.__armed
      if (!armed || event.type === 'keydown' && (event as KeyboardEvent).key !== 'ArrowRight') return
      globalThis.__armed = null
      const start = performance.now()
      globalThis.__forexReplayPerformance = { samples: {}, counts: {}, latest: globalThis.__forexReplayPerformance.latest }
      const wait = () => {
        const app = globalThis.__app, latest = globalThis.__forexReplayPerformance.latest
        if (app.replay.count !== armed.count || app.uiWorkspace.timeframes[0] !== armed.timeframe || [0, 1, 2, 3].some(id => latest[`chart.${id}.cursor`] !== armed.count)) { requestAnimationFrame(wait); return }
        requestAnimationFrame(() => { globalThis.__sample = { id: armed.id, ms: performance.now() - start, metrics: structuredClone(globalThis.__forexReplayPerformance) } })
      }
      requestAnimationFrame(wait)
    }
    window.addEventListener('keydown', begin, true); window.addEventListener('change', begin, true)
  })
  await page.goto(origin); await page.getByRole('button', { name: 'Resume backtest', exact: true }).click(); await page.locator('.phase-trading').waitFor()
  const settle = () => page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
  await settle()
  if (enabled) {
    await page.getByRole('button', { name: 'Regression', exact: true }).click()
    await page.evaluate(timestamp => globalThis.__app.setRegressionAnchor(timestamp), source[0].timestamp)
    await settle()
  }
  const anchorMetrics = await page.evaluate(() => structuredClone(globalThis.__forexReplayPerformance))
  const cases: any[] = []; let index = initial
  const perform = async (kind: string, timeframe: string, iteration: number, target: number, action: () => Promise<unknown>) => {
    const id = cases.length
    await page.evaluate(armed => { globalThis.__armed = armed }, { id, timeframe, count: target + 1 })
    await action()
    await page.waitForFunction(id => globalThis.__sample?.id === id, id, { timeout: 60000 })
    const sample = await page.evaluate(() => globalThis.__sample)
    const observations = kind === 'navigate' ? target - index : 0
    assert.equal(sample.metrics.counts['execution.observations'] ?? 0, observations)
    assert.equal(sample.metrics.counts['regression.observations'] ?? 0, enabled ? observations : 0)
    cases.push({ kind, timeframe, iteration, observations, ...sample })
  }
  for (const timeframe of ['D1', 'H4', 'M5'] as const) {
    await page.getByLabel('Chart 1 timeframe', { exact: true }).selectOption(timeframe); await settle()
    await page.locator('.chart-canvas').first().click({ position: { x: 200, y: 100 } }); await settle()
    for (let iteration = 0; iteration < samples; iteration++) {
      const target = nextCandleIndex(source, index, timeframe)
      await perform('navigate', timeframe, iteration, target, () => page.keyboard.press('Shift+ArrowRight')); index = target
    }
  }
  for (let iteration = 0; iteration < Math.max(2, samples / 2); iteration++) for (const timeframe of ['H1', 'H4', 'D1', 'M5']) {
    await perform('switch', timeframe, iteration, index, () => page.getByLabel('Chart 1 timeframe', { exact: true }).selectOption(timeframe))
  }
  // Alternate channel absence/presence at one paused cursor in the same browser
  // to distinguish channel cost from variation between full-history restores.
  if (process.env.PAIRED_SWITCHES === '1') {
    for (let iteration = 0; iteration < samples; iteration++) for (const active of iteration % 2 ? [true, false] : [false, true]) {
      await page.evaluate(anchor => globalThis.__app.setRegressionAnchor(anchor), active ? source[0].timestamp : null)
      await settle()
      for (const timeframe of ['H1', 'H4', 'D1', 'M5']) {
        await perform(active ? 'switch-on' : 'switch-off', timeframe, iteration, index, () => page.getByLabel('Chart 1 timeframe', { exact: true }).selectOption(timeframe))
      }
    }
  }
  assert.deepEqual(errors, [])
  const report = { label, enabled, sourceRoot: root, baseCommit: execFileSync('git', ['merge-base', 'HEAD', 'main'], { encoding: 'utf8' }).trim(), chromium: browser.version(),
    days: 365, charts: 4, loadedObservations: source.length, initialCount: initial + 1, initialChannelCount: enabled ? initial + 1 : 0, anchorMetrics, cases, errors }
  await writeFile(join(output, `${label}.json`), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ label, actions: cases.length, observations: source.length, errors }))
} finally {
  globalThis.fetch = nativeFetch
  if (browser) await browser.close()
  if (server) await new Promise<void>(done => server.httpServer.close(done))
  await new Promise<void>(done => { api.close(done); api.closeAllConnections() }); await storage.close(); await rm(directory, { recursive: true, force: true })
}
