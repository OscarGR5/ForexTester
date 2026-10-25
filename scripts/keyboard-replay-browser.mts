// Offline Chromium verification. Uses the local cache read-only and temporary sessions.
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { nextCandleIndex } from '../frontend/src/candleNavigation.js'
import { observeCandle } from '../frontend/src/trading.js'
import { createServer } from 'vite'
import { createApp } from '../backend/src/app.js'
import { HistoryService } from '../backend/src/history.js'
import { DatabentoClient } from '../backend/src/databento.js'
import { SessionStorage } from '../backend/src/sessionStorage.js'
import { cacheDirectory } from '../backend/src/projectPaths.js'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core')
const directory = await mkdtemp(join(tmpdir(), 'forextester-keyboard-'))
const output = 'docs/keyboard-replay-and-panel-ux'
await mkdir(output, { recursive: true })
const evidence: any = { providerRequests: 0, paidSubmissions: 0, screenshots: [], errors: [], checks: {} }
class OfflineClient extends DatabentoClient {
 constructor() { super('') }
 override async availability(): Promise<never> { evidence.providerRequests++; throw Error('Provider request forbidden') }
 override async contracts(): Promise<never> { evidence.providerRequests++; throw Error('Provider request forbidden') }
 override async cost(): Promise<never> { evidence.providerRequests++; throw Error('Provider request forbidden') }
 override async download(): Promise<never> { evidence.providerRequests++; throw Error('Provider request forbidden') }
}
const cache = join(cacheDirectory(), 'databento')
async function manifest() { return Promise.all((await readdir(cache)).sort().map(async name => [name, createHash('sha256').update(await readFile(join(cache, name))).digest('hex')])) }
const beforeCache = await manifest()
const storage = new SessionStorage({ directory: join(directory, 'sessions') })
const backend = createApp(new HistoryService(new OfflineClient(), cache, { DATABENTO_TEST_BUDGET_USD: '0' }), () => new Date(), storage)
await new Promise<void>(resolve => backend.listen(5199, '127.0.0.1', resolve))
// Verification-only access to public chart APIs. Inputs below use real Chromium events.
const vite = await createServer({ configFile: false, root: 'frontend', cacheDir: join(directory, 'vite'),
 plugins: [{ name: 'minor-chart-observation', transform(code, id) {
  if (id.endsWith('/App.tsx')) return code.replace(/const trading = useTrading\(history, replay, hydration\);?/, `const trading = useTrading(history, replay, hydration);
    globalThis.__keyboardObservation = { source, replay, trading };`)
  if (!id.endsWith('/ChartPane.tsx')) return
  return code.replace('chartRef.current = chart', `
    globalThis.__uxCharts ??= {};
    const observed = { chart, series, lines: {}, crosshair: null };
    globalThis.__uxCharts[id] = observed;
    const add = chart.addSeries.bind(chart);
    chart.addSeries = (type, options, pane) => { const line = add(type, options, pane); observed.lines[options.title] = line; return line; };
    chart.subscribeCrosshairMove(event => { observed.crosshair = { point: event.point, time: event.time }; });
    chartRef.current = chart`)
 } }], server: { watch: null, hmr: false, host: '127.0.0.1', port: 5198, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:5199', changeOrigin: false } } } })
await vite.listen()
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? '/home/admin/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell' })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await context.newPage()
await page.addInitScript('globalThis.__name = target => target')
await page.route('**/*', route => {
 const url = new URL(route.request().url())
 if (url.hostname !== '127.0.0.1' || url.pathname === '/api/history/download') {
  if (url.pathname === '/api/history/download') evidence.paidSubmissions++
  return route.abort('blockedbyclient')
 }
 return route.continue()
})
page.on('pageerror', error => evidence.errors.push(error.message))
const button = (name: string) => page.getByRole('button', { name, exact: true })
const settle = () => page.waitForTimeout(250)
async function screenshot(name: string) { const path = `${output}/${name}.png`; await page.screenshot({ path }); evidence.screenshots.push(path) }
const states = () => page.evaluate(() => Array.from(document.querySelectorAll('.chart-canvas'), (_, id) => {
 const { chart, series, lines } = (globalThis as any).__uxCharts[id]
 return { time: chart.timeScale().getVisibleLogicalRange(), price: series.priceScale().getVisibleRange(), auto: series.priceScale().options().autoScale,
  candles: series.data().length, last: series.data().at(-1), widths: Object.fromEntries(Object.entries(lines).map(([key, line]: any) => [key, line.options().lineWidth])) }
}))
const observation = () => page.evaluate(() => {
 const { replay, trading } = (globalThis as any).__keyboardObservation
 return { count: replay.count, displayCount: replay.displayCount, timestamp: replay.timestamp, reviewing: replay.reviewing,
  executionCursor: trading.executionCursor, trading: trading.state, equityCount: trading.equity.count, cash: trading.equity.cashUsd }
})
async function selectChart(id: number) {
 const box = (await page.locator('.chart-canvas').nth(id).boundingBox())!
 await page.mouse.click(box.x + 90, box.y + 90); await settle()
 assert.equal(await page.locator('.chart-pane[data-active="true"]').getAttribute('aria-label'), await page.locator('.chart-pane').nth(id).getAttribute('aria-label'))
}
async function step(timeframe: string) {
 const before = await observation()
 const source = await page.evaluate(() => (globalThis as any).__keyboardObservation.source)
 const expected = nextCandleIndex(source, before.count - 1, timeframe as any)
 await page.keyboard.press('Shift+ArrowRight'); await settle()
 const after = await observation()
 assert.equal(after.count, expected + 1)
 assert.equal(after.executionCursor - before.executionCursor, after.count - before.count)
 assert.equal(after.equityCount - before.equityCount, after.count - before.count)
 let state = before.trading
 for (let i = before.count; i < after.count; i++) state = observeCandle(state, source[i], undefined, 'single')
 assert.deepEqual(after.trading, state)
 return { before: before.timestamp, after: after.timestamp, observations: after.count - before.count, timeframe }
}
async function dismissPanels(count: number) {
 const settingsBefore = await page.evaluate(() => (globalThis as any).__keyboardObservation.trading.state)
 const info = page.getByLabel('Execution details', { exact: true })
 await info.click(); assert.equal(await page.locator('.execution-details').getAttribute('open'), '')
 await page.locator('.execution-popover > strong').click(); assert.equal(await page.locator('.execution-details').getAttribute('open'), '')
 const countBefore = (await observation()).count
 await page.keyboard.press('Shift+ArrowRight'); assert.equal((await observation()).count, countBefore)
 await page.locator('h1').click(); assert.equal(await page.locator('.execution-details').getAttribute('open'), null)
 await info.click(); await page.keyboard.press('Escape'); assert.equal(await page.locator('.execution-details').getAttribute('open'), null)
 const summaries = page.locator('.indicator-controls > summary')
 await summaries.nth(0).click()
 const input = page.getByLabel('Chart 1 BB #1 Length', { exact: true }), original = await input.inputValue()
 await input.click(); await input.fill('25'); assert.equal(await page.locator('.indicator-controls').first().getAttribute('open'), '')
 await screenshot(`indicators-${count}-${page.viewportSize()!.width}`)
 await page.locator('h1').click(); assert.equal(await page.locator('.indicator-controls').first().getAttribute('open'), null)
 await summaries.nth(0).click(); assert.equal(await input.inputValue(), '25')
 if (count > 1) {
  await summaries.nth(1).click(); assert.equal(await page.locator('.indicator-controls').first().getAttribute('open'), null)
  await page.keyboard.press('Escape'); assert.equal(await page.locator('.indicator-controls').nth(1).getAttribute('open'), null)
 }
 await summaries.nth(0).click(); if (!await input.isVisible()) await summaries.nth(0).click()
 await input.fill(original); await page.keyboard.press('Escape')
 await button('Sessions / settings').click(); await page.getByLabel('Current session name', { exact: true }).click()
 assert.equal(await page.locator('dialog.management-dialog').count(), 1)
 await screenshot(`management-${count}-${page.viewportSize()!.width}`)
 await page.mouse.click(8, 8); assert.equal(await page.locator('dialog.management-dialog').count(), 0)
 assert.equal(await button('Sessions / settings').evaluate(element => document.activeElement === element), true)
 await button('Sessions / settings').click(); await page.keyboard.press('Escape'); assert.equal(await page.locator('dialog.management-dialog').count(), 0)
 assert.deepEqual((await observation()).trading, settingsBefore)
}
try {
 await page.goto('http://127.0.0.1:5198'); await button('90 days').click(); await button('Start backtest').click()
 await page.locator('.chart-canvas').first().waitFor(); await settle()
 for (const count of [1, 2, 3]) {
  await page.locator(`input[name="chart-count"][value="${count}"]`).check()
  await page.getByLabel('Chart 1 timeframe', { exact: true }).selectOption('H1')
  if (count > 1) await page.getByLabel('Chart 2 timeframe', { exact: true }).selectOption('M5')
  if (count > 2) await page.getByLabel('Chart 3 timeframe', { exact: true }).selectOption('M15')
  for (const [width, height] of [[1440, 1000], [1100, 800]]) {
   await page.setViewportSize({ width, height }); await settle()
   assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width)
   assert.equal(await page.getByLabel('Sizing mode', { exact: true }).count(), 0)
   assert.equal(await page.getByLabel('Risk per entry (%)', { exact: true }).inputValue(), '1')
   if (count > 1) {
    await selectChart(1)
    evidence.checks[`${count}-${width}-M5`] = await step('M5')
   }
   await selectChart(0)
   evidence.checks[`${count}-${width}-H1`] = await step('H1')
   const before = await observation()
   await page.keyboard.press('Shift+ArrowLeft'); await settle()
   assert.equal((await observation()).reviewing, true)
   assert.equal(await button('Buy').isDisabled(), true); assert.equal(await button('Play').isDisabled(), true)
   assert.equal(await page.locator('.active-positions').count(), 0)
   await page.keyboard.press('Shift+ArrowLeft'); await settle()
   const review = await observation()
   assert.equal(review.count, before.count); assert.equal(review.timestamp, before.timestamp)
   assert.deepEqual(review.trading, before.trading); assert.equal(review.executionCursor, before.executionCursor); assert.equal(review.equityCount, before.equityCount)
   const source = await page.evaluate(() => (globalThis as any).__keyboardObservation.source)
   const cutoff = source[review.displayCount - 1].timestamp / 1000
   for (const state of await states()) assert.ok(state.last.time <= cutoff)
   await screenshot(`review-${count}-${width}`)
   await page.keyboard.press('Shift+ArrowRight'); await settle(); assert.equal((await observation()).reviewing, true)
   await page.keyboard.press('Shift+ArrowRight'); await settle(); assert.equal((await observation()).reviewing, false)
   assert.equal(await button('Buy').isEnabled(), true)
   await page.keyboard.press('Shift+ArrowLeft'); await button('Return to current replay').click(); await settle()
   assert.equal((await observation()).reviewing, false); assert.deepEqual((await observation()).trading, before.trading)
   await dismissPanels(count)
   await selectChart(count - 1)
   const box = (await page.locator('.chart-canvas').first().boundingBox())!
   await page.mouse.move(box.x + box.width - 15, box.y + 80); await page.mouse.wheel(0, 40); await settle()
   assert.equal(await page.locator('.chart-pane').first().getAttribute('data-active'), 'true')
   await page.waitForTimeout(1600)
   assert.equal(await page.locator('.chart-pane').first().getAttribute('data-active'), 'true')
   await screenshot(`${count}-charts-${width}`)
   evidence.checks[`${count}-${width}-reviewAndDismissal`] = { reviewCutoff: cutoff, authoritativeTimestamp: before.timestamp, tradingUnchanged: true, settingsPreserved: true }
  }
 }
 // Removing the selected pane falls back to Chart 1.
 await selectChart(2); await page.locator('input[name="chart-count"][value="2"]').check(); await settle()
 assert.equal(await page.locator('.chart-pane').first().getAttribute('data-active'), 'true')
 await selectChart(1); await page.locator('input[name="chart-count"][value="1"]').check(); await settle()
 assert.equal(await page.locator('.chart-pane').first().getAttribute('data-active'), 'true')
 // Real numeric focus and draft controls must suppress the shortcuts.
 await page.getByLabel('Risk per entry (%)', { exact: true }).click()
 let at = (await observation()).count
 await page.keyboard.press('Shift+ArrowRight'); assert.equal((await observation()).count, at)
 await button('Buy').click(); await page.keyboard.press('Shift+ArrowRight'); assert.equal((await observation()).count, at)
 await button('Cancel placement').click()
 // Place a risk-only order with the public UI and a real pointer price selection.
 await button('Buy').click()
 const observed = await observation(), quote = observed.trading.quote.trade.close
 const stop = Math.round((quote - .005) * 100000) / 100000
 const plot = (await page.locator('.chart-canvas').first().boundingBox())!
 const stopY = await page.evaluate(price => (globalThis as any).__uxCharts[0].series.priceToCoordinate(price), stop)
 if (stopY !== null && stopY > 0 && stopY < plot.height - 40) await page.mouse.click(plot.x + 100, plot.y + stopY)
 else {
  await page.getByText('Enter price with keyboard', { exact: true }).click()
  await page.getByLabel('SL price', { exact: true }).fill(String(stop))
 }
 await screenshot('risk-only-draft')
 await button('Confirm order').click()
 assert.equal((await observation()).trading.pending[0].mode, 'risk')
 assert.equal((await observation()).trading.pending[0].requestedRiskPercent, 1)
 await selectChart(0); evidence.checks.riskOrderExecution = await step('H1')
 const filled = await observation()
 assert.equal(filled.trading.positions.length + filled.trading.closed.length, 1)
 assert.equal([...filled.trading.positions, ...filled.trading.closed][0].mode, 'risk')
 await screenshot('risk-only-executed')
 await button('Sessions / settings').click(); await button('Save now').click()
 await page.waitForFunction(() => document.querySelector('.save-state')?.textContent === 'Saved')
 const saved = (await storage.list()).sessions[0]
 await page.reload(); await button('Resume backtest').click(); await page.locator('.chart-canvas').first().waitFor(); await settle()
 const restored = await observation()
 assert.deepEqual(restored.trading, saved.checkpoint.trading); assert.equal(restored.timestamp, saved.checkpoint.replay.timestamp); assert.equal(restored.reviewing, false)
 await screenshot('restored-risk-session')
 evidence.checks.savedAndRestored = { timestamp: restored.timestamp, positions: restored.trading.positions.length, completedTrades: restored.trading.closed.length }
 assert.deepEqual(await manifest(), beforeCache); evidence.checks.cacheUnchanged = true
 assert.equal(evidence.providerRequests, 0); assert.equal(evidence.paidSubmissions, 0); assert.deepEqual(evidence.errors, [])
 await writeFile(`${output}/browser-evidence.json`, JSON.stringify(evidence, null, 2) + '\n')
 console.log(JSON.stringify({ checks: evidence.checks, screenshots: evidence.screenshots.length, providerRequests: evidence.providerRequests, paidSubmissions: evidence.paidSubmissions, errors: evidence.errors }))
} catch (error) {
 await screenshot('failure'); await writeFile(`${output}/browser-failure.json`, JSON.stringify({ ...evidence, failure: String(error) }, null, 2)); throw error
} finally {
 await browser.close(); await vite.close(); await new Promise<void>(resolve => { backend.close(() => resolve()); backend.closeAllConnections() }); await storage.close()
}
