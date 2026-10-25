// Offline Chromium verification. Uses the local cache read-only and temporary sessions.
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { createApp } from '../backend/src/app.js'
import { HistoryService } from '../backend/src/history.js'
import { DatabentoClient } from '../backend/src/databento.js'
import { SessionStorage } from '../backend/src/sessionStorage.js'
import { cacheDirectory } from '../backend/src/projectPaths.js'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core')
const directory = await mkdtemp(join(tmpdir(), 'forextester-minor-chart-'))
const output = 'docs/minor-chart-refinements'
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
const span = (state: any) => state.price.to - state.price.from
function sameTime(before: any[], after: any[]) {
 for (let i = 0; i < before.length; i++) {
  assert.ok(Math.abs(before[i].time.from - after[i].time.from) < .001)
  assert.ok(Math.abs(before[i].time.to - after[i].time.to) < .001)
  assert.equal(after[i].candles, before[i].candles); assert.deepEqual(after[i].last, before[i].last)
 }
}
async function axisPoint(id: number) {
 const box = (await page.locator('.chart-canvas').nth(id).boundingBox())!
 const dimensions = await page.evaluate(id => { const { chart } = (globalThis as any).__uxCharts[id]; return { plot: chart.timeScale().width(), height: chart.panes()[0].getHeight() } }, id)
 return { x: box.x + (dimensions.plot + box.width) / 2, y: box.y + dimensions.height / 2 }
}
async function wheelAt(point: { x: number; y: number }, delta: number) { await page.mouse.move(point.x, point.y); await page.mouse.wheel(0, delta); await settle() }
try {
 await page.goto('http://127.0.0.1:5198'); await button('90 days').click(); await button('Start backtest').click()
 await page.locator('.chart-canvas').first().waitFor(); await settle()
 for (const count of [1, 2, 3]) {
  await page.locator(`input[name="chart-count"][value="${count}"]`).check(); await settle()
  // Exercise Ichimoku in every workspace pane, including the narrow stacked charts.
  for (let id = 0; id < count; id++) await page.getByLabel(`Chart ${id + 1} timeframe`, { exact: true }).selectOption('H1')
  for (const [width, height] of [[1440, 1000], [1100, 800]]) {
   await page.setViewportSize({ width, height }); await settle()
   // Start screenshots with native automatic price ranges in each pane.
   for (let id = 0; id < count; id++) {
    const point = await axisPoint(id)
    await page.mouse.dblclick(point.x, point.y); await settle()
   }
   assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width)
   assert.deepEqual(await page.locator('.pane-toolbar .instrument').allTextContents(), Array(count).fill('EURUSD 6E'))
   assert.equal(await page.locator('.pane-toolbar .bid-label').count(), 0)
   const initial = await states()
   for (const state of initial) for (const key of ['tenkan', 'kijun', 'chikou', 'spanA', 'spanB']) assert.equal(state.widths[key], 2)
   const layout = await page.locator('.pane-toolbar').evaluateAll(elements => elements.map(element => {
    const toolbar = element.getBoundingClientRect()
    return [...element.children].map(child => { const box = child.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, toolbar: { left: toolbar.left, right: toolbar.right, top: toolbar.top, bottom: toolbar.bottom } } })
   }))
   for (const children of layout) for (let i = 0; i < children.length; i++) {
    const child = children[i]; assert.ok(child.left >= child.toolbar.left && child.right <= child.toolbar.right + 1)
    assert.ok(child.top >= child.toolbar.top && child.bottom <= child.toolbar.bottom + 1)
    if (i) assert.ok(child.left >= children[i - 1].right)
   }
   await screenshot(`${count}-charts-${width}`)
   for (let id = 0; id < count; id++) {
    const before = await states(), point = await axisPoint(id)
    await wheelAt(point, -80); const expanded = await states()
    assert.ok(span(expanded[id]) < span(before[id])); assert.equal(expanded[id].auto, false); sameTime(before, expanded)
    assert.ok(Math.abs((expanded[id].price.from + expanded[id].price.to) - (before[id].price.from + before[id].price.to)) < 1e-10)
    for (let other = 0; other < count; other++) if (other !== id) assert.deepEqual(expanded[other], before[other])
    if (count === 1 && width === 1440) await screenshot('axis-wheel-expanded')
    await wheelAt(point, 80); const compressed = await states()
    assert.ok(span(compressed[id]) > span(expanded[id])); sameTime(before, compressed)
    assert.ok(Math.abs(span(compressed[id]) / span(before[id]) - 1) < .00001)
    if (count === 1 && width === 1440) await screenshot('axis-wheel-compressed')
    // Native price-axis dragging and double-click reset continue working after wheel input.
    await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.move(point.x, point.y + 30, { steps: 8 }); await page.mouse.up(); await settle()
    const dragged = await states(); assert.ok(Math.abs(span(dragged[id]) - span(compressed[id])) > 1e-10); sameTime(compressed, dragged)
    await page.mouse.dblclick(point.x, point.y); await settle(); assert.equal((await states())[id].auto, true)
    // Plot wheel stays horizontal, right-anchored and independent.
    const box = (await page.locator('.chart-canvas').nth(id).boundingBox())!
    const beforePlot = await states(); await wheelAt({ x: box.x + 110, y: point.y }, -80); const plot = await states()
    assert.ok(plot[id].time.from > beforePlot[id].time.from); assert.ok(Math.abs(plot[id].time.to - beforePlot[id].time.to) < .001)
    for (let other = 0; other < count; other++) if (other !== id) assert.deepEqual(plot[other], beforePlot[other])
    await page.mouse.move(box.x + 140, point.y); await settle()
    assert.ok(await page.evaluate(id => (globalThis as any).__uxCharts[id].crosshair?.point, id))
    await page.mouse.down(); await page.mouse.move(box.x + 190, point.y, { steps: 8 }); await page.mouse.up(); await settle()
    const panned = await states(); assert.ok(panned[id].time.to < plot[id].time.to)
    for (let other = 0; other < count; other++) if (other !== id) assert.deepEqual(panned[other], plot[other])
    evidence.checks[`${count}-charts-${width}-pane-${id + 1}`] = { before: before[id], expanded: expanded[id], compressed: compressed[id], plot: plot[id], panned: panned[id], nativeAxisDragAndReset: true, crosshair: true }
   }
  }
 }
 // Other indicator series retain their existing 1 px widths.
 await page.getByLabel('Chart 1 timeframe', { exact: true }).selectOption('M5'); await settle()
 const indicators = (await states())[0].widths
 for (const key of ['upper', 'middle', 'lower', 'upper2', 'lower2', 'k', 'd']) assert.equal(indicators[key], 1)
 evidence.checks.unrelatedIndicatorWidths = indicators
 // A vertical wheel range uses the existing persisted manual price preference.
 await page.getByLabel('Chart 1 timeframe', { exact: true }).selectOption('H1'); await settle()
 await wheelAt(await axisPoint(0), -80); await page.waitForFunction(() => document.querySelector('.save-state')?.textContent === 'Saved')
 const final = await states(), session = (await storage.list()).sessions[0]
 await page.reload(); await button('Resume backtest').click(); await page.locator('.chart-canvas').first().waitFor(); await settle()
 const restored = await states(); assert.equal(restored[0].auto, false)
 assert.ok(Math.abs(span(restored[0]) / span(final[0]) - 1) < .00001)
 const afterSession = (await storage.list()).sessions[0]
 assert.deepEqual(afterSession.checkpoint.trading, session.checkpoint.trading)
 assert.equal(afterSession.checkpoint.replay.timestamp, session.checkpoint.replay.timestamp)
 evidence.checks.manualRangeRestored = true
 assert.deepEqual(await manifest(), beforeCache); evidence.checks.cacheUnchanged = true
 assert.equal(evidence.providerRequests, 0); assert.equal(evidence.paidSubmissions, 0); assert.deepEqual(evidence.errors, [])
 await writeFile(`${output}/browser-evidence.json`, JSON.stringify(evidence, null, 2) + '\n')
 console.log(JSON.stringify({ layouts: 6, paneChecks: 12, screenshots: evidence.screenshots, providerRequests: evidence.providerRequests, paidSubmissions: evidence.paidSubmissions, errors: evidence.errors }))
} catch (error) {
 await screenshot('failure'); await writeFile(`${output}/browser-failure.json`, JSON.stringify({ ...evidence, failure: String(error) }, null, 2)); throw error
} finally {
 await browser.close(); await vite.close(); await new Promise<void>(resolve => { backend.close(() => resolve()); backend.closeAllConnections() }); await storage.close()
}
