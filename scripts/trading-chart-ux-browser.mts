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
const directory = await mkdtemp(join(tmpdir(), 'forextester-chart-ux-'))
const output = 'docs/trading-chart-ux'
await mkdir(output, { recursive: true })
const evidence: any = { isolatedSessions: directory, providerRequests: 0, paidSubmissions: 0, screenshots: [], errors: [], checks: {} }
class OfflineClient extends DatabentoClient {
 constructor() { super('') }
 override async availability(): Promise<never> { evidence.providerRequests++; throw Error('Provider request forbidden') }
 override async contracts(): Promise<never> { evidence.providerRequests++; throw Error('Provider request forbidden') }
 override async cost(): Promise<never> { evidence.providerRequests++; throw Error('Provider request forbidden') }
 override async download(): Promise<never> { evidence.providerRequests++; throw Error('Provider request forbidden') }
}
const cache = join(cacheDirectory(), 'databento')
async function manifest() { return Promise.all((await readdir(cache)).sort().map(async name => [name, createHash('sha256').update(await readFile(join(cache, name))).digest('hex')])) }
const before = await manifest()
let storage = new SessionStorage({ directory: join(directory, 'sessions') })
let backend = createApp(new HistoryService(new OfflineClient(), cache, { DATABENTO_TEST_BUDGET_USD: '0' }), () => new Date(), storage)
await new Promise<void>(resolve => backend.listen(5199, '127.0.0.1', resolve))
// Verification-only handles to public APIs. All interactions below use Chromium pointer input.
const vite = await createServer({ configFile: false, root: 'frontend', cacheDir: join(directory, 'vite'),
 plugins: [{ name: 'chart-ux-observation', transform(code, id) {
  if (!id.endsWith('/ChartPane.tsx')) return
  return code.replace('chartRef.current = chart', `globalThis.__uxCharts ??= {}; globalThis.__uxCharts[id] = { chart, series, crosshair: null }; const nativeCrosshair = chart.setCrosshairPosition.bind(chart); chart.setCrosshairPosition = (price, time, targetSeries) => { globalThis.__uxCharts[id].remote = {price, time, y: targetSeries.priceToCoordinate(price)}; nativeCrosshair(price, time, targetSeries); }; chart.subscribeCrosshairMove(p => { globalThis.__uxCharts[id].crosshair = {time: p.time, point: p.point, paneIndex: p.paneIndex}; }); chartRef.current = chart`)
 } }], server: { watch: null, hmr: false, host: '127.0.0.1', port: 5198, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:5199', changeOrigin: false } } } })
await vite.listen()
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? '/home/admin/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell' })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await context.newPage()
await page.addInitScript('globalThis.__name = target => target')
page.on('dialog', dialog => dialog.accept())
page.on('pageerror', error => evidence.errors.push(error.message))
page.on('request', request => { if (new URL(request.url()).pathname === '/api/history/download') evidence.paidSubmissions++ })
const button = (name: string) => page.getByRole('button', { name, exact: true })
const settle = () => page.waitForTimeout(250)
const saved = () => page.waitForFunction(() => document.querySelector('.save-state')?.textContent === 'Saved')
const record = async () => { await saved(); return (await storage.list()).sessions[0] }
async function screenshot(name: string) { const path = `${output}/${name}.png`; await page.screenshot({ path, fullPage: true }); evidence.screenshots.push(path) }
const ranges = () => page.evaluate(() => Object.fromEntries(Object.entries((globalThis as any).__uxCharts).filter(([id]) => Number(id) < document.querySelectorAll('.chart-pane').length).map(([id, v]: any) => [id, v.chart.timeScale().getVisibleLogicalRange()])))
async function order(direction: string, stop: number) {
 await button(direction).click(); await page.getByText('Enter price with keyboard', { exact: true }).click()
 await page.getByLabel('SL price', { exact: true }).fill(stop.toFixed(5)); await button('Confirm order').click()
}
async function stopPoint(id: string, chartId = 0) {
 const r = await record(), p = r.checkpoint.trading.positions.find(p => p.id === id)!
 const box = (await page.locator('.chart-canvas').nth(chartId).boundingBox())!
 const y = await page.evaluate(({ price, chartId }) => (globalThis as any).__uxCharts[chartId].series.priceToCoordinate(price), { price: p.stopPrice, chartId })
 assert.ok(y !== null && y > 0 && y < box.height, `Stop ${id} outside pane: ${y}`)
 return { x: box.x + box.width * .55, y: box.y + y, stop: p.stopPrice }
}
async function drag(id: string, pixels: number, cancel?: string) {
 const point = await stopPoint(id); await page.mouse.move(point.x, point.y); await page.mouse.down(); await settle()
 const chooser = page.getByRole('group', { name: 'Select overlapping stop-loss' })
 if (await chooser.isVisible()) {
  await page.mouse.up(); const box = (await chooser.getByRole('button', { name: new RegExp(id) }).boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down()
 }
 await page.mouse.move(point.x, point.y + pixels, { steps: 12 }); await settle()
 await page.getByRole('status').filter({ hasText: new RegExp(`${id} · SL`) }).waitFor()
 const r = (await storage.list()).sessions[0]; assert.equal(r.checkpoint.trading.positions.find(p => p.id === id)!.stopPrice, point.stop, 'Preview must not save trading state')
 await screenshot(cancel ? 'sl-drag-cancel-preview' : `sl-drag-${id}-preview`)
 if (cancel) await page.keyboard.press(cancel)
 await page.mouse.up(); await settle(); await saved()
 return point.stop
}
try {
 await page.goto('http://127.0.0.1:5198'); await button('90 days').click(); await button('Start backtest').click()
 await page.locator('.chart-canvas').first().waitFor(); await saved()
 assert.equal(await page.getByLabel('Replay status', { exact: true }).innerText(), 'Paused')
 assert.equal(await page.getByLabel('Chart 1 timeframe', { exact: true }).inputValue(), 'H1')
 for (const count of [1, 2, 3]) {
  await page.locator(`input[name="chart-count"][value="${count}"]`).check(); await settle()
  for (const [width, height] of [[1440, 1000], [1100, 800]]) {
   await page.setViewportSize({ width, height }); await settle(); await screenshot(`${count}-charts-${width}`)
   assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width)
   evidence.checks[`layout-${count}-${width}`] = await page.locator('.chart-pane').evaluateAll(elements => elements.map(e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }))
   assert.ok(await button('Buy').isVisible())
  }
  await page.setViewportSize({ width: 1440, height: 1000 }); await settle()
  if (count > 1) {
   const beforeZoom = await ranges(), firstBox = (await page.locator('.chart-canvas').first().boundingBox())!
   await page.mouse.move(firstBox.x + 130, firstBox.y + 100); await page.mouse.wheel(0, -80); await settle()
   const afterZoom = await ranges()
   for (let other = 1; other < count; other++) assert.deepEqual(afterZoom[other], beforeZoom[other])
   assert.ok(Math.abs(afterZoom[0].to - beforeZoom[0].to) < .001)
   evidence.checks[`wheel-${count}-charts`] = { before: beforeZoom, after: afterZoom }
  }
 }
 await page.locator('input[name="chart-count"][value="2"]').check(); await settle()
 const original = await ranges(), box = (await page.locator('.chart-canvas').first().boundingBox())!
 await page.mouse.move(box.x + box.width * .2, box.y + box.height * .4); await page.mouse.wheel(0, -240); await settle()
 const zoomed = await ranges(); assert.deepEqual(zoomed[1], original[1]); assert.ok(zoomed[0].from > original[0].from); assert.ok(Math.abs(zoomed[0].to - original[0].to) < .001)
 await page.mouse.move(box.x + box.width * .8, box.y + box.height * .4); await page.mouse.wheel(0, 80); await settle()
 const zoomOut = await ranges(); assert.ok(Math.abs(zoomOut[0].to - zoomed[0].to) < .001); assert.ok(zoomOut[0].from < zoomed[0].from)
 evidence.checks.independentWheel = { original, zoomed, zoomOut }; await screenshot('independent-zoom')
 // Genuine horizontal pan while keeping the second chart unchanged.
 await page.mouse.move(box.x + 150, box.y + 120); await page.mouse.down(); await page.mouse.move(box.x + 330, box.y + 120, { steps: 15 }); await page.mouse.up(); await settle()
 const panned = await ranges(); assert.deepEqual(panned[1], original[1]); assert.ok(panned[0].to < zoomOut[0].to)
 const viewBeforeTick = JSON.stringify(panned[0]); await button('Next Candle').click(); await settle(); assert.equal(JSON.stringify((await ranges())[0]), viewBeforeTick)
 evidence.checks.independentPanAndManualHold = panned
 // Crosshair source price must come from its pointer, irrespective of indicator proximity.
 const current = await record(), observed = current.checkpoint.trading.quote!.trade!.close
 // Return to the latest area by undoing the pan with real pointer input.
 await page.mouse.move(box.x + 330, box.y + 120); await page.mouse.down(); await page.mouse.move(box.x + 150, box.y + 120, { steps: 15 }); await page.mouse.up(); await settle()
 const cross = await page.evaluate(price => { const { chart, series } = (globalThis as any).__uxCharts[0]; const range = chart.timeScale().getVisibleLogicalRange(); return { x: chart.timeScale().logicalToCoordinate(Math.floor(range.to - 30)), y: series.priceToCoordinate(price) } }, observed + .00013)
 await page.mouse.move(box.x + cross.x, box.y + cross.y); await settle()
 evidence.checks.crosshair = await page.evaluate(() => {
  const source = (globalThis as any).__uxCharts[0], target = (globalThis as any).__uxCharts[1]
  return { source: source.crosshair, target: target.remote, sourcePrice: source.series.coordinateToPrice(source.crosshair.point.y), targetPrice: target.remote?.price, mode: source.chart.options().crosshair.mode, sourceScale: source.series.priceScale().getVisibleRange(), targetScale: target.series.priceScale().getVisibleRange() }
 })
 assert.equal(evidence.checks.crosshair.mode, 0); assert.ok(Math.abs(evidence.checks.crosshair.sourcePrice - evidence.checks.crosshair.targetPrice) < .000005)
 await screenshot('free-crosshair')
 // Use small manual lots so the interaction check does not depend on risk-sizing estimates.
 await page.getByLabel('Sizing mode', { exact: true }).selectOption('manual'); await page.getByLabel('Volume (lots)', { exact: true }).fill('0.01')
 const stop = Math.round((observed - .0005) * 100000) / 100000
 await order('Buy', stop); await order('Buy', stop); await button('Next Candle').click(); await settle()
 let state = (await record()).checkpoint.trading; assert.equal(state.positions.length, 2); assert.equal(state.setups.length, 1)
 const [first, second] = state.positions.map(p => p.id)
 const unchanged = await drag(first, -12, 'Escape'); state = (await record()).checkpoint.trading; assert.equal(state.positions[0].stopPrice, unchanged); assert.equal(state.positions[0].stopModifications.length, 0)
 await drag(first, -8); state = (await record()).checkpoint.trading; assert.equal(state.positions[0].stopModifications.length, 1); assert.equal(state.positions[1].stopModifications.length, 0)
 await drag(second, 8); state = (await record()).checkpoint.trading; assert.equal(state.positions[1].stopModifications.length, 1)
 const invalidPoint = await stopPoint(first)
 const invalidY = await page.evaluate(() => { const { series } = (globalThis as any).__uxCharts[0]; return series.priceToCoordinate(series.data().at(-1).close) - 30 })
 await page.mouse.move(invalidPoint.x, invalidPoint.y); await page.mouse.down(); await page.mouse.move(invalidPoint.x, box.y + invalidY, { steps: 10 }); await page.mouse.up(); await settle(); await saved()
 assert.equal((await record()).checkpoint.trading.positions.find(p => p.id === first)!.stopPrice, invalidPoint.stop)
 await page.getByRole('alert').filter({ hasText: /SL must be/ }).waitFor(); await screenshot('invalid-sl-snapback'); await button('Dismiss').click()
 evidence.checks.invalidRelease = true
 evidence.checks.longStops = structuredClone(state.positions)
 await button('Next Candle').click(); await saved()
 for (const p of (await record()).checkpoint.trading.positions) await button(`Close ${p.id}`).click()
 await button('Next Candle').click(); await saved(); state = (await record()).checkpoint.trading; assert.equal(state.positions.length, 0); assert.equal(state.closed.length, 2); assert.equal(new Set(state.closed.map(p => p.setupId)).size, 1)
 const now = state.quote!.trade!.close
 await order('Sell', now + .005); await button('Next Candle').click(); await settle(); state = (await record()).checkpoint.trading
 assert.equal(state.setups.length, 2); const short = state.positions[0]; assert.equal(short.direction, 'sell')
 await drag(short.id, 8); assert.equal((await record()).checkpoint.trading.positions[0].stopModifications.length, 1)
 evidence.checks.shortStop = (await record()).checkpoint.trading.positions[0]
 await button(`Close ${short.id}`).click(); await button('Next Candle').click(); await saved()
 await page.getByLabel('Chart 1 timeframe', { exact: true }).selectOption('D1'); await settle()
 assert.match(await page.locator('.chart-pane').first().locator('.indicator-readiness').innerText(), /warming up.*\/ 78 completed D1/)
 evidence.checks.d1Readiness = await page.locator('.chart-pane').first().locator('.indicator-readiness').innerText(); await screenshot('d1-warmup')
 await button('Next Candle').click(); await saved(); const checkpoint = (await record()).checkpoint, views = await ranges()
 await new Promise<void>(resolve => { backend.close(() => resolve()); backend.closeAllConnections() })
 await storage.close()
 storage = new SessionStorage({ directory: join(directory, 'sessions') })
 backend = createApp(new HistoryService(new OfflineClient(), cache, { DATABENTO_TEST_BUDGET_USD: '0' }), () => new Date(), storage)
 await new Promise<void>(resolve => backend.listen(5199, '127.0.0.1', resolve))
 evidence.checks.backendRestart = true
 // Clear browser presentation preferences: recovery must use the durable checkpoint.
 await page.reload(); await button('Resume backtest').waitFor(); await page.evaluate(() => localStorage.clear()); await button('Resume backtest').click(); await page.locator('.chart-canvas').first().waitFor(); await settle(); await saved()
 const restored = (await record()).checkpoint
 assert.deepEqual(restored.trading, checkpoint.trading); assert.equal(restored.replay.timestamp, checkpoint.replay.timestamp)
 assert.deepEqual(restored.workspace.timeframes, checkpoint.workspace.timeframes); assert.deepEqual(await ranges(), views)
 evidence.checks.durableRestore = { replayTimestamp: restored.replay.timestamp, timeframes: restored.workspace.timeframes, views, closed: restored.trading.closed.length, setups: restored.trading.setups.length }
 await screenshot('durable-restored')
 await button('Finish backtest').click(); await button('Journal').click()
 assert.equal(await page.locator('[data-journal-setup-id]').count(), 2)
 evidence.checks.journalGrouping = await page.locator('[data-journal-setup-id]').evaluateAll(rows => rows.map(row => ({ setupId: row.getAttribute('data-journal-setup-id'), positions: row.querySelectorAll('td')[2].textContent, status: row.querySelectorAll('td')[3].textContent })))
 assert.deepEqual(evidence.checks.journalGrouping.map((row: any) => row.positions), ['2','1'])
 assert.ok(evidence.checks.journalGrouping.every((row: any) => row.status === 'completed'))
 evidence.checks.closedTrades = restored.trading.closed.map(p => ({ id: p.id, setupId: p.setupId, exitReason: p.exitReason, stopModifications: p.stopModifications, netPnlUsd: p.netPnlUsd }))
 await screenshot('journal-setup-grouping')
 assert.deepEqual(await manifest(), before); evidence.checks.cacheUnchanged = true
 assert.equal(evidence.providerRequests, 0); assert.equal(evidence.paidSubmissions, 0); assert.deepEqual(evidence.errors, [])
 await writeFile(`${output}/browser-evidence.json`, JSON.stringify(evidence, null, 2) + '\n'); console.log(JSON.stringify(evidence.checks, null, 2))
} catch (error) { await screenshot('failure'); await writeFile(`${output}/browser-failure.json`, JSON.stringify({ ...evidence, failure: String(error) }, null, 2)); throw error }
finally { await browser.close(); await vite.close(); await new Promise<void>(resolve => { backend.close(() => resolve()); backend.closeAllConnections() }); await storage.close() }
