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
const directory = await mkdtemp(join(tmpdir(), 'forextester-trade-shortcuts-'))
const output = 'docs/trade-shortcuts-and-combined-pnl'
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
const beforeCache = await manifest()
const storage = new SessionStorage({ directory: join(directory, 'sessions') })
const backend = createApp(new HistoryService(new OfflineClient(), cache, { DATABENTO_TEST_BUDGET_USD: '0' }), () => new Date(), storage)
await new Promise<void>(resolve => backend.listen(5199, '127.0.0.1', resolve))
// Verification-only access to public chart APIs. Inputs below use real Chromium events.
const vite = await createServer({ configFile: false, root: 'frontend', cacheDir: join(directory, 'vite'),
 plugins: [{ name: 'trade-shortcut-observation', transform(code, id) {
  if (id.endsWith('/App.tsx')) return code.replace('synchronizer.advance(bounds)', 'globalThis.__uxSync = synchronizer; synchronizer.advance(bounds)').replace(/const trading = useTrading\(history, replay, hydration\);?/, `const trading = useTrading(history, replay, hydration);
    globalThis.__keyboardObservation = { source, replay, trading, draft, stopPreview };`)
  if (!id.endsWith('/ChartPane.tsx')) return
  return code.replace('chartRef.current = chart', `
    globalThis.__uxCharts ??= {};
    const observed = { chart, series, stopLabels: stopLines.current.labels, lines: {}, crosshair: null };
    globalThis.__uxCharts[id] = observed;
    const add = chart.addSeries.bind(chart);
    chart.addSeries = (type, options, pane) => { const line = add(type, options, pane); observed.lines[options.title] = line; return line; };
    chart.subscribeCrosshairMove(event => { observed.crosshair = { point: event.point, time: event.time }; });
    chartRef.current = chart`)
 } }], server: { watch: null, hmr: false, host: '127.0.0.1', port: 5198, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:5199', changeOrigin: false } } } })
await vite.listen()
const browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'], executablePath: process.env.CHROMIUM_PATH ?? '/home/admin/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell' })
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
const observation = () => page.evaluate(() => { const { trading, replay } = (globalThis as any).__keyboardObservation; return { trading: trading.state, timestamp: replay.timestamp, reviewing: replay.reviewing } })
const saved = () => page.waitForFunction(() => document.querySelector('.save-state')?.textContent === 'Saved')
async function point(price: number, id = 0) {
 const box = (await page.locator('.chart-canvas').nth(id).boundingBox())!
 const y = await page.evaluate(({ price, id }) => (globalThis as any).__uxCharts[id].series.priceToCoordinate(price), { price, id })
 assert.ok(y !== null && y > 0 && y < box.height, `Price outside pane: ${y}`)
 return { x: box.x + 80, y: box.y + y }
}
const round = (value: number) => Math.round(value * 100000) / 100000
const focusChart = () => page.locator('h1').click()
async function ignored(key: string, reason: string) {
 const before = await observation()
 await page.keyboard.press(key); await settle()
 assert.equal(await page.locator('.stop-placement').count(), 0, reason)
 const after = await observation()
 assert.deepEqual(after.trading.pending, before.trading.pending, reason)
 evidence.checks[reason] = true
}
async function pnlEvidence() {
 const state = (await observation()).trading
 const individual = await page.locator('.active-positions [data-position-id] > span:nth-of-type(2)').allTextContents()
 const nets = state.positions.map((p: any) => (state.quote.trade.close - p.entryPrice) * (p.direction === 'buy' ? 1 : -1) * p.lots * 100000 - p.entryCommissionUsd - p.lots * p.commission.roundTripUsdPerLot / 2)
 const net = nets.reduce((sum: number, value: number) => sum + value, 0)
 const formatted = (value: number) => `${value < 0 ? '-' : ''}$${Math.abs(value).toFixed(2)} (${(value / state.account.referenceBalance * 100).toFixed(2)}%)`
 assert.deepEqual(individual, nets.map((value: number) => `Est. net ${formatted(value)}`))
 const total = await page.locator('.open-total strong').innerText()
 assert.equal(total, formatted(net))
 const color = await page.locator('.open-total strong').evaluate(el => getComputedStyle(el).color)
 assert.equal(color, net < 0 ? 'rgb(226, 162, 166)' : 'rgb(117, 196, 181)')
 return { individual, total, net, color, openIds: state.positions.map((p: any) => p.id), account: await page.getByLabel('Account PnL', { exact: true }).innerText() }
}
async function layoutEvidence() {
 const result = await page.evaluate(() => {
  const box = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height } }
  const strip = document.querySelector<HTMLElement>('.active-positions')
  const total = document.querySelector('.open-total')
  return { viewport: innerWidth, pageWidth: document.documentElement.scrollWidth, toolbar: box(document.querySelector('.workspace-toolbar')!),
   controls: Array.from(document.querySelectorAll('.dock-controls > label, .dock-controls > button, .dock-controls > span')).map(box),
   positions: strip ? Array.from(strip.children).map(box) : [], strip: strip ? { ...box(strip), scrollWidth: strip.scrollWidth, clientWidth: strip.clientWidth } : null,
   total: total ? box(total) : null }
 })
 assert.equal(result.pageWidth, result.viewport, 'No full-page horizontal overflow')
 assert.equal(result.toolbar.height, 39, JSON.stringify(result))
 for (const row of [...result.controls, ...result.positions, ...(result.total ? [result.total] : [])]) {
  assert.ok(row.y >= result.toolbar.y && row.bottom <= result.toolbar.bottom, JSON.stringify(result))
 }
 if (result.total && result.strip) {
  assert.ok(result.total.x >= result.strip.right, JSON.stringify(result))
  assert.ok(result.total.right <= result.viewport - 14, JSON.stringify(result))
  // The focusable strip supports native horizontal arrow scrolling and Tab.
  await page.locator('.active-positions').focus()
  if (result.strip.scrollWidth > result.strip.clientWidth) {
   await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await settle()
  }
  for (const _ of result.positions) await page.keyboard.press('Tab')
  await settle()
  const close = (await page.locator('.active-positions > div').last().getByRole('button').boundingBox())!
  const focus = await page.evaluate(() => ({ active: document.activeElement?.getAttribute('aria-label'), scrollLeft: document.querySelector('.active-positions')!.scrollLeft }))
  assert.ok(close.x >= result.strip.x && close.x + close.width <= result.strip.right + 1, JSON.stringify({ close, focus, result }))
  Object.assign(result.strip, { scrollLeftAfterKeyboard: focus.scrollLeft })
  await focusChart()
 }
 return result
}
async function matrix(prefix: string, screenshots = false) {
 for (const count of [1, 2, 3]) {
  await page.locator(`input[name="chart-count"][value="${count}"]`).check()
  for (const [width, height] of [[1440, 1000], [1100, 800], [1000, 800]]) {
   await page.setViewportSize({ width, height }); await settle()
   evidence.checks[`${prefix}-${count}-${width}`] = { layout: await layoutEvidence(), ...(await page.locator('.open-total').count() ? { pnl: await pnlEvidence() } : {}) }
   if (screenshots) await screenshot(`${prefix}-${count}-${width}`)
  }
 }
 await page.setViewportSize({ width: 1440, height: 1000 }); await page.locator('input[name="chart-count"][value="1"]').check(); await settle(); await focusChart()
}
async function startDraft(key: string, stop: number, expectedSlot: number, capture: string) {
 await focusChart()
 const before = (await observation()).trading
 await page.keyboard.press(key); await settle()
 assert.match(await page.locator('.stop-placement').innerText(), new RegExp(`slot ${expectedSlot}`))
 assert.deepEqual((await observation()).trading, before, 'Shortcut only starts placement')
 // Held key and other direction cannot replace an existing draft.
 const draft = await page.evaluate(() => (globalThis as any).__keyboardObservation.draft)
 await page.keyboard.down(key); await page.keyboard.down(key); await page.keyboard.up(key)
 await page.keyboard.press(key.toLowerCase() === 'b' ? 's' : 'b')
 assert.deepEqual(await page.evaluate(() => (globalThis as any).__keyboardObservation.draft), draft)
 await page.evaluate(({ stop }) => {
  const { series } = (globalThis as any).__uxCharts[0]
  const quote = (globalThis as any).__keyboardObservation.trading.state.quote.trade.close
  series.priceScale().setVisibleRange({ from: Math.min(stop, quote) - .002, to: Math.max(stop, quote) + .002 })
 }, { stop }); await settle()
 const at = await point(stop), near = await point(stop + .0002)
 await page.mouse.move(at.x, at.y); await settle()
 const pips = await page.locator('.draft-stop-annotation').first().innerText()
 assert.match(pips, /pips/)
 await page.mouse.click(at.x, at.y); await settle()
 assert.deepEqual((await observation()).trading, before, 'Chart selection still needs confirmation')
 // Selected draft retains dragging, pip preview and chart confirmation tick.
 await page.mouse.move(at.x, at.y); await page.mouse.down(); await page.mouse.move(near.x, near.y, { steps: 5 }); await page.mouse.up(); await settle()
 assert.deepEqual((await observation()).trading, before, 'Draft dragging cannot submit')
 assert.equal(await button('Confirm order').isEnabled(), true)
 await screenshot(capture)
 if (expectedSlot === 1) await button('Confirm draft stop-loss').first().click()
 else await button('Confirm order').click()
 await saved(); await settle()
 const state = (await observation()).trading
 assert.equal(state.pending.length, 1)
 evidence.checks[capture] = { key, pips, draft, pending: state.pending, beforeOpenCount: before.positions.length }
}
try {
 await page.goto('http://127.0.0.1:5198'); await button('90 days').click()
 await page.getByText('Advanced settings', { exact: true }).click()
 await page.getByRole('spinbutton', { name: 'Round-trip commission (USD per standard lot)', exact: true }).fill('7')
 await button('Start backtest').click(); await page.locator('.chart-canvas').first().waitFor(); await settle(); await saved()
 await page.evaluate(() => {
  (globalThis as any).__keyEvidence = []
  window.addEventListener('keydown', event => {
   const { draft } = (globalThis as any).__keyboardObservation
   ;(globalThis as any).__keyEvidence.push({ key: event.key, repeat: event.repeat, ctrl: event.ctrlKey, alt: event.altKey, meta: event.metaKey,
    target: (event.target as Element)?.tagName, prevented: event.defaultPrevented, draft: draft ? { direction: draft.direction, slot: draft.slot } : null })
  })
 })
 await matrix('empty')
 // Typing and held-key/modifier safety before there are any orders.
 const risk = page.getByRole('spinbutton', { name: 'Risk per entry (%)', exact: true })
 await risk.fill('.5'); await ignored('b', 'typing-number'); await focusChart()
 for (const combination of ['Control+b', 'Alt+b', 'Meta+s']) await ignored(combination, `modifier-${combination}`)
 const repeated = await page.evaluate(() => { const e = new KeyboardEvent('keydown', { key: 'b', repeat: true, cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented })
 assert.equal(repeated, false); assert.equal(await page.locator('.stop-placement').count(), 0); evidence.checks.heldKey = true
 for (const label of ['Execution details', 'Indicators']) {
  const control = page.locator(label === 'Indicators' ? '.indicator-controls > summary' : '.execution-details > summary').first()
  await control.click(); await ignored('b', `panel-${label}`); await page.keyboard.press('Escape')
 }
 await button('Sessions / settings').click(); await ignored('b', 'management'); await button('Close management').click()
 await focusChart(); await page.keyboard.press('s'); await settle()
 assert.match(await page.locator('.stop-placement').innerText(), /Sell · slot 1/)
 await screenshot('sell-keyboard-draft'); await page.keyboard.press('Escape'); await settle()
 assert.equal(await page.locator('.stop-placement').count(), 0); assert.equal((await observation()).trading.pending.length, 0)
 evidence.checks.sellAndEscape = true
 const market = round((await observation()).trading.quote.trade.close)
 await startDraft('b', round(market - .003), 1, 'buy-keyboard-first-draft')
 assert.equal(await page.locator('.open-total').count(), 0, 'Pending-only total hidden')
 assert.equal((await observation()).trading.pending[0].requestedRiskPercent, .5)
 await button('Next Candle').click(); await saved(); await settle()
 assert.equal((await observation()).trading.positions.length, 1)
 evidence.checks.firstFill = await pnlEvidence()
 await ignored('s', 'opposite-direction')
 // Replay and review guards while only one slot is occupied.
 await page.getByLabel('Replay speed', { exact: true }).selectOption('1')
 await button('Play').click(); await ignored('b', 'playback'); await button('Pause').click()
 await focusChart(); const beforeReview = await observation()
 await page.keyboard.press('Shift+ArrowLeft'); await settle()
 assert.equal((await observation()).reviewing, true)
 await ignored('b', 'historical-review')
 assert.deepEqual((await observation()).trading, beforeReview.trading)
 await page.keyboard.press('Shift+ArrowRight'); await settle()
 assert.equal((await observation()).reviewing, false)
 evidence.checks.shiftArrows = true
 // Drag a confirmed stop while the second entry is still eligible.
 const position = (await observation()).trading.positions[0]
 const stop = await point(position.stopPrice)
 await page.mouse.move(stop.x, stop.y); await page.mouse.down(); await page.mouse.move(stop.x, stop.y - 4, { steps: 4 }); await settle()
 assert.equal(await page.locator('.stop-drag-status').count(), 1)
 await ignored('b', 'confirmed-stop-drag'); await page.keyboard.press('Escape'); await page.mouse.up(); await settle()
 assert.equal((await observation()).trading.positions[0].stopPrice, position.stopPrice)
 await risk.fill('.35'); await startDraft('B', round(market - .0035), 2, 'buy-keyboard-second-draft')
 assert.equal((await observation()).trading.pending[0].requestedRiskPercent, .35)
 evidence.checks.mixedOpenPending = await pnlEvidence()
 await ignored('b', 'two-slots'); await button('Next Candle').click(); await saved(); await settle()
 assert.equal((await observation()).trading.positions.length, 2)
 assert.equal((await observation()).trading.setups.length, 1)
 const beforeAdvance = await pnlEvidence()
 await focusChart(); await page.keyboard.press('Shift+ArrowRight'); await saved(); await settle()
 const afterAdvance = await pnlEvidence()
 assert.notEqual(afterAdvance.total, beforeAdvance.total)
 assert.notDeepEqual(afterAdvance.individual, beforeAdvance.individual)
 evidence.checks.liveUpdate = { before: beforeAdvance, after: afterAdvance }
 await matrix('two-open', true)
 evidence.keyboardEvents = await page.evaluate(() => (globalThis as any).__keyEvidence)
 // Durable state, account PnL and open totals survive reload.
 await saved(); const checkpoint = (await observation()).trading, restoredPnl = await pnlEvidence()
 await page.reload(); await button('Resume backtest').click(); await page.locator('.chart-canvas').first().waitFor(); await settle(); await saved()
 assert.deepEqual((await observation()).trading, checkpoint)
 assert.deepEqual(await pnlEvidence(), restoredPnl); await screenshot('restored-two-open'); evidence.checks.savedReload = true
 const first = checkpoint.positions[0].id
 await button(`Close ${first}`).click(); await button('Next Candle').click(); await saved(); await settle()
 const remaining = await pnlEvidence()
 assert.equal(remaining.individual.length, 1)
 assert.equal(remaining.individual[0].replace('Est. net ', ''), remaining.total)
 assert.equal((await observation()).trading.closed.length, 1)
 evidence.checks.closedOne = remaining
 await matrix('one-open')
 await screenshot('one-open-after-close')
 const second = (await observation()).trading.positions[0].id
 await button(`Close ${second}`).click(); await button('Next Candle').click(); await saved(); await settle()
 assert.equal(await page.locator('.open-total').count(), 0)
 evidence.checks.closedAll = true
 // Sell submission as well as Sell placement is exercised with the same confirm flow.
 const sellMarket = round((await observation()).trading.quote.trade.close)
 await startDraft('s', round(sellMarket + .003), 1, 'sell-keyboard-confirmation')
 await button('Next Candle').click(); await saved(); await settle()
 assert.equal((await observation()).trading.positions[0].direction, 'sell')
 evidence.checks.sellFill = await pnlEvidence()
 assert.deepEqual(await manifest(), beforeCache); evidence.cacheManifest = beforeCache; evidence.checks.cacheUnchanged = true
 assert.equal(evidence.providerRequests, 0); assert.equal(evidence.paidSubmissions, 0); assert.deepEqual(evidence.errors, [])
 await writeFile(`${output}/browser-evidence.json`, JSON.stringify(evidence, null, 2) + '\n')
 console.log(JSON.stringify({ checks: Object.keys(evidence.checks), keyboardEvents: evidence.keyboardEvents.length, screenshots: evidence.screenshots.length, providerRequests: evidence.providerRequests, paidSubmissions: evidence.paidSubmissions, errors: evidence.errors }, null, 2))
} catch (error) { await screenshot('failure'); await writeFile(`${output}/browser-failure.json`, JSON.stringify({ ...evidence, failure: String(error) }, null, 2)); throw error }
finally { await browser.close(); await vite.close(); await new Promise<void>(resolve => { backend.close(() => resolve()); backend.closeAllConnections() }); await storage.close() }
