import '../backend/src/environment.js'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
import { RegressionCalculator, regressionPrices } from '../frontend/src/regressionChannel.js'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core')
const output = resolve(process.env.REGRESSION_OUTPUT ?? 'docs/regression-channel')
await mkdir(output, { recursive: true })
const directory = await mkdtemp(join(tmpdir(), 'forextester-regression-'))
const storage = new SessionStorage({ directory }), archive = new LocalArchive(), api = createApp(archive, undefined, storage)
await new Promise<void>(done => api.listen(0, '127.0.0.1', done))
const apiOrigin = `http://127.0.0.1:${api.address().port}`, nativeFetch = globalThis.fetch
let server: any, browser: any
const instrument = { name: 'regression-verification', enforce: 'pre' as const, transform(code: string, path: string) {
  if (path.endsWith('/src/ChartPane.tsx')) return code.replace('seriesRef.current = series', 'seriesRef.current = series; (globalThis.__charts ??= {})[id] = { chart, series, primitive: regressionOverlay.current }')
  if (path.endsWith('/src/App.tsx')) return code.replace('const pnl = accountPnl', 'globalThis.__app = { replay, trading, regression, regressionAnchor, chartSource, setChartCount }; const pnl = accountPnl')
} }
try {
  const history = { ...await archive.load('EURUSD', '2022-11-25', '2022-12-25', '2022-07-28'), tradingFrom: '2022-11-25' }
  const source = history.candles, initial = source.findIndex(c => c.timestamp >= Date.parse('2022-12-07')), startIndex = source.findIndex(c => c.timestamp >= Date.parse(history.tradingFrom))
  let state = { ...createTradingState(7), symbol: 'EURUSD' as const, executionModel: 'single-price-m1-v1' as const }, ledger = createEquityLedger(state.account.referenceBalance)
  for (let index = startIndex; index <= initial; index++) { const before = state; state = observeCandle(state, source[index], undefined, 'single'); ledger = recordEquity(ledger, before, state) }
  globalThis.fetch = ((path: string, init?: RequestInit) => nativeFetch(`${apiOrigin}${path}`, { ...init, headers: { Origin: apiOrigin, ...init?.headers } })) as typeof fetch
  const client = new DiskSessionStore(), historyId = await historyFingerprint(history)
  const call = client.call.bind(client)
  client.call = (async (path: string, method = 'GET', body: any) => method === 'POST' && path.startsWith('/sessions/') ? storage.save(body.record, body.chunks, body.expectedRevision) : call(path, method, body)) as typeof client.call
  await client.cacheHistory(historyId, history)
  const fixtures: { width: number; id: string }[] = []
  for (const width of [1440, 1100]) {
    let workspace = selectChartMode(defaultWorkspace(), 1)
    workspace = updateActiveChartMode(workspace, { timeframes: ['M5', 'H4', 'H1'], indicators: [{ M5: indicatorPreset('M5') }, { H4: indicatorPreset('H4') }, { H1: indicatorPreset('H1') }] })
    const id = crypto.randomUUID()
    await client.save({ id, name: `Regression ${width}`, createdAt: new Date().toISOString(), range: { from: history.tradingFrom, to: history.to }, historyId, totalCandles: source.length }, { ledger, checkpoint: {
      lifecycle: 'trading', replay: { started: true, index: initial, timestamp: source[initial].timestamp, startIndex, startTimestamp: source[startIndex].timestamp, speed: 1, complete: false, playing: false },
      executionCursor: initial + 1, trading: state, equity: equitySummary(ledger), workspace,
    } }, null)
    fixtures.push({ width, id })
  }
  globalThis.fetch = nativeFetch
  const outDir = join(directory, 'dist')
  await build({ configFile: false, root: resolve('frontend'), plugins: [instrument], build: { outDir, emptyOutDir: true, reportCompressedSize: false } })
  server = await preview({ configFile: false, root: resolve('frontend'), build: { outDir }, preview: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: apiOrigin } } } })
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/home/admin/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome', headless: true, args: ['--no-sandbox'] })
  const reports: any[] = []
  for (const fixture of fixtures) {
    const { width, id } = fixture, context = await browser.newContext({ viewport: { width, height: width === 1100 ? 800 : 1000 } }), page = await context.newPage()
    const errors: string[] = [], external: string[] = [], requests: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => { requests.push(request.url()); if (!request.url().startsWith(origin) && !request.url().startsWith('data:')) external.push(request.url()) })
    await context.addInitScript(() => { globalThis.__name = (target: unknown) => target; globalThis.__forexReplayPerformance = { samples: {}, counts: {}, latest: {} } })
    const settle = () => page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
    const probe = () => page.evaluate(() => {
      const app = globalThis.__app
      return { anchor: app.regressionAnchor, fit: app.regression, displayCount: app.replay.displayCount, count: app.replay.count, reviewing: app.replay.reviewing,
        seriesCounts: Object.values(globalThis.__charts).map((p: any) => p.series.data().length),
        paneFits: [...document.querySelectorAll('.chart-canvas')].map((_, id) => globalThis.__charts[id].primitive.channel),
        shared: [...document.querySelectorAll('.chart-canvas')].every((_, id) => globalThis.__charts[id].primitive.channel === app.regression),
        trading: JSON.stringify(app.trading.state) }
    })
    const verify = async () => {
      await settle(); const current = await probe()
      const expected = new RegressionCalculator(source).update(current.anchor, current.displayCount)
      assert.deepEqual(current.fit, expected); assert(current.shared)
      for (const fit of current.paneFits) assert.deepEqual(fit, expected)
      return current
    }
    const ctrlClickPoint = async (pane: number, point: { x: number; y: number }) => {
      const box = await page.locator('.chart-canvas').nth(pane).boundingBox()
      assert(box)
      await page.keyboard.down('Control')
      await page.mouse.click(box.x + point.x, box.y + point.y)
      await page.keyboard.up('Control')
      await settle()
    }
    const clickCandle = async (pane: number, barsBack: number) => {
      const point = await page.evaluate(({ pane, barsBack }) => {
        const { chart, series } = globalThis.__charts[pane], candles = series.data(), bar = candles[Math.max(0, candles.length - barsBack)]
        const x = chart.timeScale().timeToCoordinate(bar.time), y = Math.min(120, chart.panes()[0].getHeight() / 2)
        return { x, y, time: bar.time, visible: chart.timeScale().getVisibleLogicalRange() }
      }, { pane, barsBack })
      assert(point.x !== null && point.x > 0)
      await ctrlClickPoint(pane, point)
      return point
    }
    const linePoint = (pane: number, boundary: 'upper' | 'middle' | 'lower') => page.evaluate(({ pane, boundary }) => {
      const { chart, series, primitive } = globalThis.__charts[pane], channel = primitive.channel
      const offset = boundary === 'upper' ? channel.offset : boundary === 'lower' ? -channel.offset : 0
      const points = primitive.projectedVertices(chart.timeScale().width()).map((point: any) => ({ x: point.x,
        y: series.priceToCoordinate(channel.intercept + channel.slope * point.observation + offset) }))
        .filter((p: any) => p.x > 30 && p.x < chart.timeScale().width() - 30 && p.y > 20 && p.y < chart.panes()[0].getHeight() - 20)
      if (!points.length) throw new Error('No visible channel segment')
      return points[Math.floor(points.length / 2)]
    }, { pane, boundary })
    const save = async () => {
      await page.getByRole('button', { name: 'Sessions / settings', exact: true }).click()
      await page.getByRole('button', { name: 'Save now', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('.save-state')?.textContent === 'Saved')
      await page.getByRole('button', { name: 'Close management', exact: true }).click()
    }
    try {
      await page.goto(origin)
      const row = page.locator('.saved-session').filter({ hasText: `Regression ${width}` })
      await row.getByRole('button', { name: 'Resume backtest', exact: true }).click()
      await page.locator('.phase-trading').waitFor(); await settle()
      assert.equal(await page.getByRole('button', { name: 'Regression', exact: true }).getAttribute('aria-pressed'), 'false')
      await page.getByRole('button', { name: 'Regression', exact: true }).click()
      const before = await probe(), clicked = await clickCandle(0, 30), anchored = await verify()
      const anchor = source.find(c => c.timestamp >= clicked.time * 1000)!.timestamp
      assert.equal(anchored.anchor, anchor); assert(anchored.fit && anchored.fit.count >= 3)
      assert.deepEqual(anchored.seriesCounts, before.seriesCounts)
      assert.equal(anchored.trading, before.trading)
      const original = anchored.fit, values = regressionPrices(original, original.count - 1)
      const overlap = await page.evaluate(() => {
        const { chart, series, primitive } = globalThis.__charts[0], app = globalThis.__app, channel = app.regression
        const scale = chart.timeScale(), source = app.chartSource, width = scale.width()
        if (primitive.paneViews()[0].zOrder() !== 'bottom') throw new Error('Regression must render at bottom')
        for (const candle of series.data()) {
          if (candle.time * 1000 < source[channel.startIndex].timestamp) continue
          let low = channel.startIndex, high = channel.endIndex + 1
          while (low < high) { const mid = (low + high) >>> 1; if (source[mid].timestamp < candle.time * 1000) low = mid + 1; else high = mid }
          if (low > channel.endIndex || source[low].timestamp !== candle.time * 1000) continue
          const x = scale.timeToCoordinate(candle.time), y = series.priceToCoordinate(channel.intercept + channel.slope * (low - channel.startIndex))
          const a = series.priceToCoordinate(candle.open), b = series.priceToCoordinate(candle.close)
          if (x > 30 && x < width - 30 && y > Math.min(a, b) + 2 && y < Math.max(a, b) - 2) return { x, y }
        }
        throw new Error('No regression/candle-body intersection for paint-order verification')
      })
      const pixel = () => page.evaluate(({ x, y }) => {
        const element = document.querySelector('.chart-canvas')!, plot = element.getBoundingClientRect()
        const { chart } = globalThis.__charts[0]
        const canvas = [...element.querySelectorAll('canvas')].find(c => {
          const rect = c.getBoundingClientRect()
          return rect.width >= chart.timeScale().width() - 1 && Math.abs(rect.height - chart.panes()[0].getHeight()) < 2
        })!
        const box = canvas.getBoundingClientRect()
        return [...canvas.getContext('2d')!.getImageData(Math.floor((plot.left + x - box.left) * canvas.width / box.width), Math.floor((plot.top + y - box.top) * canvas.height / box.height), 1, 1).data]
      }, overlap)
      const candlePixel = await pixel()
      assert([[255, 255, 255, 255], [41, 98, 255, 255]].some(color => JSON.stringify(color) === JSON.stringify(candlePixel)), `Candle must cover regression: ${candlePixel}`)
      // Control: raise only the primitive in this disposable chart, compare the
      // same pixel, then restore bottom order before continuing interaction tests.
      await page.evaluate(() => { const primitive = globalThis.__charts[0].primitive; primitive.paneViews()[0].zOrder = () => 'normal'; primitive.requestUpdate() })
      await settle(); const channelPixel = await pixel()
      assert(channelPixel[0] > 200 && channelPixel[1] > 100 && channelPixel[2] < 180, `Normal-order control must cover candle: ${channelPixel}`)
      await page.evaluate(() => { const primitive = globalThis.__charts[0].primitive; primitive.paneViews()[0].zOrder = () => 'bottom'; primitive.requestUpdate() })
      await settle(); assert.deepEqual(await pixel(), candlePixel)
      await page.screenshot({ path: `${output}/m5-${width}.png`, fullPage: true })
      for (const timeframe of ['H1', 'D1']) {
        await page.getByLabel('Chart 1 timeframe', { exact: true }).selectOption(timeframe)
        const switched = await verify(); assert.deepEqual(switched.fit, original)
        assert.deepEqual(regressionPrices(switched.fit!, switched.fit!.count - 1), values)
        // A few hours occupy a fraction of one D1 bar. Zoom the existing axis
        // for visual inspection without adding candles or changing the fit.
        await page.evaluate(() => {
          const { chart, series } = globalThis.__charts[0]
          const last = series.data().at(-1).time, logical = chart.timeScale().timeToIndex(last)
          chart.timeScale().setVisibleLogicalRange({ from: logical - 2, to: logical + 3 })
        })
        await settle()
        await page.screenshot({ path: `${output}/${timeframe.toLowerCase()}-${width}.png`, fullPage: true })
      }
      await page.getByLabel('Chart 1 timeframe', { exact: true }).selectOption('M5'); await settle()
      await page.getByRole('button', { name: 'Next Min', exact: true }).click()
      const next = await verify(); assert.equal(next.fit!.count, original.count + 1)
      await page.locator('.chart-canvas').first().click({ position: { x: 150, y: 100 } })
      await page.keyboard.press('Shift+ArrowRight')
      const higher = await verify(); assert(higher.fit!.count > next.fit!.count)
      await page.keyboard.press('Control+Shift+ArrowLeft')
      const review = await verify(); assert(review.reviewing); assert(review.fit!.count < higher.fit!.count); assert.equal(review.trading, higher.trading)
      await page.getByRole('button', { name: 'Return to current replay', exact: true }).click(); await verify()
      const second = await clickCandle(0, 15), replaced = await verify()
      assert.equal(replaced.anchor, source.find(c => c.timestamp >= second.time * 1000)!.timestamp); assert.notEqual(replaced.anchor, anchor)
      await page.getByRole('button', { name: 'Regression', exact: true }).click()
      await clickCandle(0, 30); const disabled = await verify(); assert.deepEqual(disabled.fit, replaced.fit)
      await page.locator('input[name="chart-count"][value="4"]').check(); await settle()
      const four = await verify(); assert.equal(four.paneFits.length, 4); assert.deepEqual(four.fit, replaced.fit)
      await page.getByRole('button', { name: 'Executions', exact: true }).click()
      await page.getByRole('button', { name: 'Original SL', exact: true }).click()
      await page.getByRole('button', { name: 'Buy', exact: true }).click()
      await page.getByLabel('Enter price with keyboard', { exact: true }).click()
      const stop = source[higher.count - 1].close - .001
      await page.getByLabel('SL price', { exact: true }).fill(stop.toFixed(7))
      await page.getByRole('button', { name: 'Confirm order', exact: true }).click()
      await page.getByRole('button', { name: 'Next Min', exact: true }).click()
      const withPosition = await verify()
      assert.equal(JSON.parse(withPosition.trading).positions.length, 1)
      await page.screenshot({ path: `${output}/four-${width}.png`, fullPage: true })
      // A modifier click must also leave an in-progress trade draft untouched.
      await page.getByRole('button', { name: 'Regression', exact: true }).click()
      await page.getByRole('button', { name: 'Buy', exact: true }).click()
      const draftBefore = await page.locator('.stop-placement').innerText()
      await clickCandle(2, 20); const draftAnchored = await verify()
      assert.equal(await page.locator('.stop-placement').innerText(), draftBefore)
      assert.equal(draftAnchored.trading, withPosition.trading)
      await page.keyboard.press('Escape')
      await save()
      const durable = (await storage.list()).sessions.find(r => r.id === id)!
      assert.equal(durable.checkpoint.regressionAnchor, draftAnchored.anchor)
      await page.reload(); await row.getByRole('button', { name: 'Resume backtest', exact: true }).click()
      await page.locator('.phase-trading').waitFor(); const restored = await verify()
      assert.deepEqual(restored.fit, draftAnchored.fit)
      assert.equal(restored.trading, withPosition.trading)
      assert.equal(await page.getByRole('button', { name: 'Regression', exact: true }).getAttribute('aria-pressed'), 'true')
      const point = await linePoint(2, 'middle')
      await page.getByRole('button', { name: 'Regression', exact: true }).click()
      await ctrlClickPoint(2, point); assert.deepEqual((await verify()).fit, restored.fit)
      await page.getByRole('button', { name: 'Regression', exact: true }).click()
      const deletions: string[] = []
      for (const boundary of ['upper', 'middle', 'lower'] as const) {
        await ctrlClickPoint(2, await linePoint(2, boundary))
        const deleted = await verify()
        assert.equal(deleted.anchor, null); assert.deepEqual(deleted.paneFits, [null, null, null, null])
        assert.equal(deleted.trading, restored.trading)
        assert.equal(await page.getByRole('button', { name: 'Regression', exact: true }).getAttribute('aria-pressed'), 'true')
        deletions.push(boundary)
        if (boundary !== 'lower') { await clickCandle(2, 20); assert((await verify()).fit) }
      }
      await save()
      assert.equal((await storage.list()).sessions.find(r => r.id === id)!.checkpoint.regressionAnchor, null)
      await page.reload(); await row.getByRole('button', { name: 'Resume backtest', exact: true }).click()
      await page.locator('.phase-trading').waitFor()
      assert.deepEqual((await verify()).paneFits, [null, null, null, null])
      assert.equal(await page.getByRole('button', { name: 'Regression', exact: true }).getAttribute('aria-pressed'), 'true')
      await clickCandle(2, 20); assert((await verify()).fit)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      assert.deepEqual(errors, []); assert.deepEqual(external, [])
      reports.push({ width, chromium: browser.version(), observations: source.length, anchor, original, endpointPrices: values, forwardCount: higher.fit!.count, reviewCount: review.fit!.count,
        replacementAnchor: replaced.anchor, restoredAnchor: restored.anchor, fourChartShared: restored.shared, pageErrors: errors, externalRequests: external,
        deletions, deletionRestoredEmpty: true, paintOrder: { candlePixel, channelPixel, restoredBottomPixel: candlePixel },
        historyRequests: requests.filter(url => url.includes('/api/history?')).length, metrics: await page.evaluate(() => globalThis.__forexReplayPerformance) })
    } catch (error) { await page.screenshot({ path: `${output}/failure-${width}.png`, fullPage: true }); console.error(await page.locator('body').innerText()); throw error }
    finally { await context.close() }
  }
  await writeFile(`${output}/browser-verification.json`, JSON.stringify(reports, null, 2) + '\n')
  console.log(JSON.stringify(reports.map(({ metrics, ...report }) => report), null, 2))
} finally {
  globalThis.fetch = nativeFetch
  if (browser) await browser.close()
  if (server) await new Promise<void>(done => server.httpServer.close(done))
  await new Promise<void>(done => { api.close(done); api.closeAllConnections() })
  await storage.close(); await rm(directory, { recursive: true, force: true })
}
