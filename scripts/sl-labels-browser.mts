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
const directory = await mkdtemp(join(tmpdir(), 'forextester-sl-labels-'))
const output = 'docs/sl-labels'
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
  return code.replace('stopLines.current = new StopLines(series)', `globalThis.__uxCharts ??= {}; const record = { chart, series, lines: new Set(), primitive: null, annotationText: [] }; globalThis.__uxCharts[id] = record; const create = series.createPriceLine.bind(series), remove = series.removePriceLine.bind(series), attach = series.attachPrimitive.bind(series); series.createPriceLine = options => { const line = create(options); record.lines.add(line); return line; }; series.removePriceLine = line => { record.lines.delete(line); remove(line); }; series.attachPrimitive = primitive => { if ('setData' in primitive) { record.primitive = primitive; const renderer = primitive.paneViews()[0].renderer(), draw = renderer.draw.bind(renderer); renderer.draw = target => { record.annotationText = []; draw({ useMediaCoordinateSpace: action => target.useMediaCoordinateSpace(scope => { const nativeFillText = scope.context.fillText; scope.context.fillText = function(text, ...args) { record.annotationText.push(text); return nativeFillText.call(this, text, ...args); }; try { action(scope); } finally { scope.context.fillText = nativeFillText; } }) }); }; } attach(primitive); }; stopLines.current = new StopLines(series)`)

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
async function chartStops() {
 return page.evaluate(() => Object.values((globalThis as any).__uxCharts).slice(0, document.querySelectorAll('.chart-pane').length).map((record: any) => ({
  stops: record.primitive.stops,
  annotationText: record.annotationText,
  lines: [...record.lines].map((line: any) => line.options()),
  rows: record.primitive.stops.map((stop: any) => ({ id: stop.id, y: record.series.priceToCoordinate(stop.price) })),
 })))
}
async function verifyAnnotations(number?: number) {
 await settle()
 for (const pane of await chartStops()) {
  assert.equal(pane.annotationText.length, pane.stops.length)
  assert.deepEqual([...pane.annotationText].sort(), pane.stops.map((stop: any) => stop.annotation).sort())
  for (const stop of pane.stops) {
   assert.ok(!stop.annotation.includes(stop.price.toFixed(5)), 'Canvas must not duplicate the axis price')
   assert.match(stop.annotation, /SL [12] · ~?[\d.]+ pips · (?:est\. )?[+-]\$[\d.]+/)
   if (number !== undefined) assert.equal(stop.number, number)
   assert.ok(pane.lines.some((line: any) => line.price === stop.price && line.axisLabelVisible && line.title === '' && line.color === '#ef9a9a'))
  }
 }
}
async function point(price: number, chartId = 0) {
 const box = (await page.locator('.chart-canvas').nth(chartId).boundingBox())!
 const y = await page.evaluate(({ price, chartId }) => (globalThis as any).__uxCharts[chartId].series.priceToCoordinate(price), { price, chartId })
 assert.ok(y !== null && y > 0 && y < box.height, `SL price outside pane: ${y}`)
 return { x: box.x + 80, y: box.y + y }
}
async function order(stop: number) {
 await button('Buy').click(); await settle()
 const at = await point(stop); await page.mouse.move(at.x, at.y); await page.mouse.click(at.x, at.y)
 await page.getByRole('region', { name: 'Place stop-loss' }).waitFor()
 assert.equal(await button('Confirm order').isEnabled(), true)
 await screenshot('draft-sl'); await button('Confirm order').click(); await saved()
}
async function drag(id: string, pixels: number, cancel = false) {
 const p = (await record()).checkpoint.trading.positions.find(p => p.id === id)!, at = await point(p.stopPrice)
 await page.mouse.move(at.x, at.y); await page.mouse.down(); await settle()
 const chooser = page.getByRole('group', { name: 'Select overlapping stop-loss' })
 if (await chooser.isVisible()) {
  await page.mouse.up(); const box = (await chooser.getByRole('button', { name: new RegExp(id) }).boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down()
 }
 await page.mouse.move(at.x, at.y + pixels, { steps: 12 }); await settle()
 const preview = await chartStops(); assert.notEqual(preview[0].stops.find((s: any) => s.id === id).price, p.stopPrice)
 assert.equal((await storage.list()).sessions[0].checkpoint.trading.positions.find(p => p.id === id)!.stopPrice, p.stopPrice)
 await screenshot(cancel ? 'drag-cancel-preview' : `drag-${id}-preview`)
 if (cancel) await page.keyboard.press('Escape')
 await page.mouse.up(); await settle(); await saved()
 const updated = (await record()).checkpoint.trading.positions.find(p => p.id === id)!
 assert.equal(updated.stopModifications.length, cancel ? p.stopModifications.length : p.stopModifications.length + 1)
 if (cancel) assert.equal(updated.stopPrice, p.stopPrice)
 else {
  const stop = (await chartStops())[0].stops.find((s: any) => s.id === id)
  const expectedNet = (updated.stopPrice - updated.entryPrice) * 100000 * updated.lots - updated.entryCommissionUsd - updated.lots * updated.commission.roundTripUsdPerLot / 2
  assert.ok(Math.abs(stop.netUsd - expectedNet) < 1e-7)
  assert.ok(Math.abs(stop.pips - Math.abs(updated.stopPrice - updated.entryPrice) / .0001) < 1e-7)
 }
}
try {
 await page.goto('http://127.0.0.1:5198'); await button('90 days').click()
 await page.getByText('Advanced settings', { exact: true }).click()
 await page.getByLabel('Round-trip commission (USD per standard lot)', { exact: true }).fill('7')
 await button('Start backtest').click(); await page.locator('.chart-canvas').first().waitFor(); await saved()
 await page.getByLabel('Sizing mode', { exact: true }).selectOption('manual'); await page.getByLabel('Volume (lots)', { exact: true }).fill('0.1')
 const initial = (await record()).checkpoint, observed = initial.trading.quote!.trade!.close
 await order(observed - .0005)
 const pendingOne = (await record()).checkpoint
 assert.equal(pendingOne.replay.timestamp, initial.replay.timestamp)
 for (const pane of await chartStops()) {
  assert.equal(pane.stops.length, 1); assert.equal(pane.stops[0].pending, true); assert.match(pane.stops[0].label, /^Pending SL 1 .*pips.*est\./)
  assert.equal(pane.lines[0].axisLabelVisible, true); assert.equal(pane.lines[0].lineStyle, 2)
 }
 await verifyAnnotations(1)
 evidence.checks.pendingBeforeCandle = await chartStops(); await screenshot('one-pending-before-fill')
 await button('Next Candle').click(); await saved()
 const activeOne = (await record()).checkpoint.trading
 assert.equal(activeOne.positions.length, 1); assert.equal(activeOne.pending.length, 0)
 assert.equal((await chartStops())[0].stops[0].id, pendingOne.trading.pending[0].id)
 assert.equal((await chartStops())[0].stops[0].pending, false)
 await verifyAnnotations(1); await screenshot('one-active-sl')
 await order(activeOne.positions[0].stopPrice)
 evidence.checks.activeAndPending = await chartStops(); await screenshot('active-and-pending')
 await button('Next Candle').click(); await saved()
 let state = (await record()).checkpoint.trading; assert.equal(state.positions.length, 2)
 const [first, second] = state.positions.map(p => p.id)
 for (const pane of await chartStops()) {
  assert.equal(pane.stops.length, 2); assert.match(pane.stops[0].label, /^SL 1 /); assert.match(pane.stops[1].label, /^SL 2 /)
  assert.ok(pane.lines.every((line: any) => line.color === '#ef9a9a' && line.lineStyle === 0))
 }
 await verifyAnnotations(); await screenshot('two-close-active-sls'); evidence.checks.twoActive = await chartStops()
 await drag(first, 8, true); await drag(first, 12); await drag(second, 20)
 await screenshot('two-modified-sls'); evidence.checks.modified = await chartStops()
 // Check all pane layouts with real chart rendering and the same confirmed stops.
 for (const count of [2, 3]) {
  await page.locator(`input[name="chart-count"][value="${count}"]`).check(); await settle()
  for (const pane of await chartStops()) assert.equal(pane.stops.length, 2)
  await screenshot(`two-sls-${count}-panes`)
 }
 await page.setViewportSize({ width: 1100, height: 800 }); await settle(); await screenshot('two-sls-laptop')
 assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 1100)
 await page.setViewportSize({ width: 1440, height: 1000 }); await settle()
 await button(`Close ${first}`).click(); await button('Next Candle').click(); await saved()
 assert.equal((await record()).checkpoint.trading.positions.length, 1)
 await verifyAnnotations(2)
 evidence.checks.sl2AfterFirstCloses = await chartStops(); await screenshot('sl-2-after-sl-1-close')
 await button(`Close ${second}`).click(); await button('Next Candle').click(); await saved()
 assert.equal((await record()).checkpoint.trading.positions.length, 0)
 // Two independently confirmed pending stops survive a backend restart and refresh.
 const now = (await record()).checkpoint.trading.quote!.trade!.close
 await order(now - .003); await order(now - .0031)
 const checkpoint = (await record()).checkpoint
 assert.equal(checkpoint.trading.pending.length, 2)
 for (const pane of await chartStops()) { assert.equal(pane.stops.length, 2); assert.ok(pane.stops.every((s: any) => s.pending)) }
 await screenshot('two-pending-before-fill'); evidence.checks.twoPending = await chartStops()
 await new Promise<void>(resolve => { backend.close(() => resolve()); backend.closeAllConnections() }); await storage.close()
 storage = new SessionStorage({ directory: join(directory, 'sessions') })
 backend = createApp(new HistoryService(new OfflineClient(), cache, { DATABENTO_TEST_BUDGET_USD: '0' }), () => new Date(), storage)
 await new Promise<void>(resolve => backend.listen(5199, '127.0.0.1', resolve))
 await page.reload(); await button('Resume backtest').click(); await page.locator('.chart-canvas').first().waitFor(); await settle(); await saved()
 assert.deepEqual((await record()).checkpoint.trading, checkpoint.trading)
 for (const pane of await chartStops()) { assert.equal(pane.stops.length, 2); assert.ok(pane.stops.every((s: any) => s.pending)) }
 await screenshot('pending-restored-after-backend-restart'); evidence.checks.pendingRestored = await chartStops()
 await button(`Cancel entry ${checkpoint.trading.pending[0].id}`).click(); await saved()
 for (const pane of await chartStops()) assert.equal(pane.stops.length, 1)
 await verifyAnnotations(2)
 evidence.checks.cancelPending = await chartStops(); await screenshot('sl-2-after-sl-1-cancel')
 const cancelled = (await record()).checkpoint
 await page.reload(); await button('Resume backtest').click(); await page.locator('.chart-canvas').first().waitFor(); await saved()
 assert.deepEqual((await record()).checkpoint.trading, cancelled.trading)
 await verifyAnnotations(2)
 evidence.checks.sl2RestoredAfterCancel = await chartStops(); await screenshot('sl-2-restored-after-cancel')
 await button('Next Candle').click(); await saved()
 state = (await record()).checkpoint.trading; assert.equal(state.positions.length, 1); assert.equal(state.pending.length, 0)
 for (const pane of await chartStops()) { assert.equal(pane.stops.length, 1); assert.equal(pane.stops[0].pending, false) }
 await verifyAnnotations(2)
 evidence.checks.sl2FilledAfterCancel = await chartStops(); await screenshot('sl-2-filled-after-cancel')
 assert.deepEqual(await manifest(), before); evidence.checks.cacheUnchanged = true
 assert.equal(evidence.providerRequests, 0); assert.equal(evidence.paidSubmissions, 0); assert.deepEqual(evidence.errors, [])
 await writeFile(`${output}/browser-evidence.json`, JSON.stringify(evidence, null, 2) + '\n'); console.log(JSON.stringify({ checks: Object.keys(evidence.checks), providerRequests: evidence.providerRequests, paidSubmissions: evidence.paidSubmissions, errors: evidence.errors }, null, 2))
} catch (error) { await screenshot('failure'); await writeFile(`${output}/browser-failure.json`, JSON.stringify({ ...evidence, failure: String(error) }, null, 2)); throw error }
finally { await browser.close(); await vite.close(); await new Promise<void>(resolve => { backend.close(() => resolve()); backend.closeAllConnections() }); await storage.close() }
