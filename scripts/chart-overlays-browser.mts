// Production-bundle Chromium verification with synthetic fills and isolated disk sessions.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { preview } from 'vite'
import { sessionApi } from '../backend/src/sessionApi.js'
import { SessionStorage } from '../backend/src/sessionStorage.js'
import { DiskSessionStore } from '../frontend/src/diskSessionStore.js'
import { historyFingerprint } from '../frontend/src/sessionCodec.js'
import { createEquityLedger, recordEquity } from '../frontend/src/equity.js'
import { createTradingState, requestAutomaticEntry, requestClose, modifyStop, observeCandle } from '../frontend/src/trading.js'
import { defaultWorkspace } from '../frontend/src/uiPreferences.js'
import { equitySummary } from '../frontend/src/sessionTypes.js'

const output = 'docs/original-sl', directory = await mkdtemp(join(tmpdir(), 'forextester-chart-overlays-'))
await mkdir(output, { recursive: true })
const storage = new SessionStorage({ directory }), reports: unknown[] = []
const api = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  if (await sessionApi(req, res, storage)) return
  if (req.url?.startsWith('/api/history/datasets')) { res.end(JSON.stringify({ datasets: [] })); return }
  if (req.url?.startsWith('/api/history/calendar')) { res.end(JSON.stringify({ days: [] })); return }
  res.writeHead(404); res.end('{}')
})
await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve))
const apiOrigin = `http://127.0.0.1:${(api.address() as { port: number }).port}`
const nativeFetch = globalThis.fetch
const start = Date.UTC(2024, 0, 1), permission = { active: true, playing: false, hasFuture: true }
const bar = (timestamp: number, index: number) => {
  const open = 1.1 + Math.sin(index / 90) * .0006
  return { timestamp, open, high: open + .0001, low: open - .0001, close: open + .00002 }
}
const bid = [ ...Array.from({ length: 90 }, (_, i) => bar(start - (90 - i) * 86400000, i)),
  ...Array.from({ length: 3 * 1440 }, (_, i) => bar(start + i * 60000, i)) ]
const history = { symbol: 'EURUSD' as const, resolution: 'M1' as const, tradingFrom: '2024-01-01', from: '2023-10-03', to: '2024-01-04', bid,
  ask: bid.map(c => ({ ...c, open: c.open + .0002, high: c.high + .0002, low: c.low + .0002, close: c.close + .0002 })) }
let state = createTradingState(), ledger = createEquityLedger(state.account.referenceBalance)
for (let offset = 0; offset <= 720; offset++) {
  const index = 90 + offset, previous = state
  state = observeCandle(state, history.bid[index], history.ask[index]); ledger = recordEquity(ledger, previous, state)
  if (offset === 0 || offset === 650) {
    const direction = offset === 0 ? 'buy' : 'sell', stop = direction === 'buy' ? 1.09915 : 1.101
    state = requestAutomaticEntry(state, direction, { mode: 'risk', riskPercent: .5 }, stop + .0001, permission)
    state = requestAutomaticEntry(state, direction, { mode: 'risk', riskPercent: .5 }, stop, permission)
  }
  if ([30, 90, 660, 690].includes(offset)) {
    const position = state.positions[0], price = position.stopPrice + (position.direction === 'buy' ? .00002 : -.00002)
    state = modifyStop(state, position.id, price, permission)
  }
  if ([710, 715].includes(offset)) state = modifyStop(state, state.positions[1].id, state.positions[1].stopPrice - .00002, permission)
  if ([180, 240].includes(offset)) state = requestClose(state, state.positions[0].id, permission)
}
const initialTrading = structuredClone(state)
let id: string
try {
  globalThis.fetch = ((path: string, init?: RequestInit) => nativeFetch(`${apiOrigin}${path}`, { ...init, headers: { Origin: apiOrigin, ...init?.headers } })) as typeof fetch
  const store = new DiskSessionStore(), historyId = await historyFingerprint(history)
  id = crypto.randomUUID()
  await store.cacheHistory(historyId, history)
  await store.save({ id, name: 'Synthetic executions and original SL', createdAt: new Date().toISOString(), range: { from: history.tradingFrom, to: history.to }, historyId, totalCandles: bid.length },
    { ledger, checkpoint: { lifecycle: 'trading', trading: state, equity: equitySummary(ledger), executionCursor: 811,
      replay: { started: true, index: 810, timestamp: bid[810].timestamp, startIndex: 90, startTimestamp: start, speed: 1, complete: false, playing: false }, workspace: defaultWorkspace() } }, null)
} finally { globalThis.fetch = nativeFetch }
const server = await preview({ configFile: false, root: resolve('frontend'), preview: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: apiOrigin, changeOrigin: false } } } })
const origin = `http://127.0.0.1:${(server.httpServer.address() as { port: number }).port}`
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core')
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/home/admin/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome', headless: true, args: ['--no-sandbox'] })
try {
  for (const width of [1100, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: width === 1100 ? 800 : 1000 } }), page = await context.newPage()
    const errors: string[] = [], external: string[] = []
    await page.addInitScript(id => {
      const key = `forextester:ui:v1:${id}`, preferences = JSON.parse(localStorage.getItem(key) ?? '{}')
      // Keep both original stops onscreen using existing manual price preferences.
      for (let pane = 0; pane < 4; pane++) for (const tf of ['M5', 'M15', 'H1', 'H4', 'D1']) preferences[`price:${pane}:${tf}`] = { autoScale: false, range: { from: 1.0988, to: 1.1015 } }
      localStorage.setItem(key, JSON.stringify(preferences))
      ;(globalThis as any).__forexReplayPerformance = { samples: {}, counts: {}, latest: {} }
      ;(globalThis as any).__overlayDraws = { triangles: 0, arrows: 0, stops: 0 }
      ;(globalThis as any).__originalSlLines = {}
      const fill = CanvasRenderingContext2D.prototype.fill, stroke = CanvasRenderingContext2D.prototype.stroke
      const begin = CanvasRenderingContext2D.prototype.beginPath, move = CanvasRenderingContext2D.prototype.moveTo, line = CanvasRenderingContext2D.prototype.lineTo
      CanvasRenderingContext2D.prototype.beginPath = function() { (this as any).__points = []; return begin.call(this) }
      CanvasRenderingContext2D.prototype.moveTo = function(x, y) { (this as any).__points?.push([x, y]); return move.call(this, x, y) }
      CanvasRenderingContext2D.prototype.lineTo = function(x, y) { (this as any).__points?.push([x, y]); return line.call(this, x, y) }
      CanvasRenderingContext2D.prototype.fill = function(...args: any[]) {
        const points = (this as any).__points ?? []
        if (points.length === 3 && Math.abs(points[1][0] - points[2][0]) === 8 && (this.fillStyle === '#75c4b5' || this.fillStyle === '#e2a2a6')) (globalThis as any).__overlayDraws.triangles++
        return fill.apply(this, args as any)
      }
      CanvasRenderingContext2D.prototype.stroke = function(...args: any[]) {
        const dash = this.getLineDash().join(',')
        if (dash === '3,4') (globalThis as any).__overlayDraws.arrows++
        if (dash === '4,4' && String(this.strokeStyle).includes('0.28')) {
          ;(globalThis as any).__overlayDraws.stops++
          const pane = [...document.querySelectorAll('.chart-pane')].indexOf(this.canvas.closest('.chart-pane')!)
          const points = (this as any).__points
          ;(globalThis as any).__originalSlLines[`${pane}:${points[0][1]}`] = { pane, points, lineWidth: this.lineWidth }
        }
        return stroke.apply(this, args as any)
      }
    }, id)
    page.on('pageerror', e => errors.push(e.message))
    await page.route('**/*', route => { if (!route.request().url().startsWith(origin)) { external.push(route.request().url()); return route.abort() } return route.continue() })
    const button = (name: string) => page.getByRole('button', { name, exact: true })
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const resetDraws = () => page.evaluate(() => { (globalThis as any).__overlayDraws = { triangles: 0, arrows: 0, stops: 0 } })
    const draws = () => page.evaluate(() => (globalThis as any).__overlayDraws)
    const originalLines = async (expectedPerPane: number) => {
      await button('Original SL').click(); await settle()
      await page.evaluate(() => { (globalThis as any).__originalSlLines = {} })
      await button('Original SL').click(); await settle()
      const lines = await page.evaluate(() => Object.values((globalThis as any).__originalSlLines) as { pane: number; points: number[][]; lineWidth: number }[])
      for (let pane = 0; pane < 4; pane++) assert.equal(lines.filter(line => line.pane === pane).length, expectedPerPane, `Original SL count in pane ${pane}`)
      for (const line of lines) {
        assert.equal(line.lineWidth, 1); assert.equal(line.points[0][0], 0)
        assert.equal(line.points[0][1], line.points[1][1]); assert(line.points[1][0] > 0)
      }
      return lines
    }
    try {
      await page.goto(origin); await button('Resume backtest').click(); await page.locator('.phase-trading').waitFor()
      assert.equal(await button('Executions').getAttribute('aria-pressed'), 'false')
      assert.equal(await button('Original SL').getAttribute('aria-pressed'), 'false')
      for (const count of [1, 2, 3, 4, 1, 4]) {
        await page.locator(`input[name="chart-count"][value="${count}"]`).check(); await settle()
        assert.equal(await page.locator('.chart-pane').count(), count)
      }
      assert.deepEqual(await page.locator('.pane-toolbar select').evaluateAll(elements => elements.map(el => (el as HTMLSelectElement).value)), ['H1', 'D1', 'M5', 'H4'])
      const rectangles = await page.locator('.chart-pane').evaluateAll(elements => elements.map(el => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height } }))
      assert(rectangles[0].x === rectangles[2].x && rectangles[1].x === rectangles[3].x && rectangles[0].y === rectangles[1].y && rectangles[2].y === rectangles[3].y && rectangles[2].y > rectangles[0].y)
      await page.screenshot({ path: `${output}/off-${width}.png` })
      await resetDraws(); await button('Executions').click(); await settle()
      const executions = await draws(); assert(executions.triangles >= 6 && executions.arrows >= 2)
      await resetDraws(); await button('Original SL').click(); await settle()
      const historyDraws = await draws(); assert(historyDraws.stops > 0)
      const restoredLines = await originalLines(2)
      await page.screenshot({ path: `${output}/four-${width}.png` })
      // Each pane can switch independently and receives the same global overlays.
      for (let pane = 0; pane < 4; pane++) {
        for (const timeframe of ['M5', 'M15', 'H1', 'H4', 'D1']) {
          const select = page.getByLabel(`Chart ${pane + 1} timeframe`)
          if (await select.inputValue() === timeframe) continue
          await resetDraws(); await select.selectOption(timeframe); await settle()
          assert((await draws()).triangles > 0, `No visible markers: pane ${pane + 1}, ${timeframe}`)
        }
      }
      for (let pane = 0; pane < 4; pane++) await page.getByLabel(`Chart ${pane + 1} timeframe`).selectOption(['H1', 'D1', 'M5', 'H4'][pane])
      await page.locator('.indicator-controls summary').first().click(); await page.screenshot({ path: `${output}/indicators-${width}.png` }); await page.keyboard.press('Escape')
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      const unchanged = (await storage.list()).sessions.find(record => record.id === id)!
      assert.deepEqual(unchanged.checkpoint.trading, initialTrading)
      await page.reload(); await button('Resume backtest').click(); await page.locator('.phase-trading').waitFor()
      assert.equal(await page.locator('.chart-pane').count(), 4)
      assert.equal(await button('Executions').getAttribute('aria-pressed'), 'true'); assert.equal(await button('Original SL').getAttribute('aria-pressed'), 'true')
      await button('Next Min').click()
      await page.waitForFunction(() => {
        const metrics = (globalThis as any).__forexReplayPerformance.latest
        return metrics && [0,1,2,3].every(id => metrics[`chart.${id}.cursor`] === 812)
      })
      await originalLines(2)
      await page.getByLabel('Chart 1 timeframe').selectOption('M5')
      await page.locator('.chart-canvas').first().click({ position: { x: 100, y: 100 } })
      for (let step = 0; step < 3; step++) { await page.keyboard.press('Shift+ArrowLeft'); await settle() }
      await button('Return to current replay').waitFor(); await settle()
      await originalLines(1) // 11:49: only the first position has changed.
      await page.getByLabel('Chart 1 timeframe').selectOption('H1')
      await page.locator('.chart-canvas').first().click({ position: { x: 100, y: 100 } })
      await page.keyboard.press('Shift+ArrowLeft'); await settle()
      await originalLines(0) // 10:59: neither position has changed yet.
      await button('Return to current replay').click(); await settle(); await originalLines(2)
      const [first, second] = initialTrading.positions
      await button(`Close ${first.id}`).click(); await settle(); await originalLines(2)
      await page.screenshot({ path: `${output}/pending-${width}.png` })
      await page.waitForFunction(() => document.querySelector('.save-state')?.textContent === 'Saved')
      await page.reload(); await button('Resume backtest').click(); await page.locator('.phase-trading').waitFor(); await settle()
      assert.equal(await button(`Close ${first.id}`).textContent(), 'Close pending')
      await originalLines(2)
      await button('Next Min').click(); await settle(); await originalLines(1)
      await button(`Close ${second.id}`).click(); await settle(); await originalLines(1)
      await button('Next Min').click(); await settle(); await originalLines(0)
      await page.screenshot({ path: `${output}/closed-${width}.png` })
      // Turning both off removes all optional drawing, including after pan/zoom.
      await button('Executions').click(); await button('Original SL').click(); await settle(); await resetDraws()
      await page.mouse.move(180, 250); await page.mouse.wheel(0, 100); await settle()
      assert.deepEqual(await draws(), { triangles: 0, arrows: 0, stops: 0 })
      assert.deepEqual(errors, []); assert.deepEqual(external, [])
      reports.push({ width, rectangles, executions, historyDraws, restoredLines, errors, external, checks: ['1/2/3/4 switching', '2x2 ordering', 'global toggles off by default', 'multiple open/closed buy/sell fills', 'one original SL per position after multiple changes', 'all pane/timeframe combinations', 'indicator dropdown', 'restored slHistory preference and records', 'synchronized replay cursors', 'no future modification leaked during historical review', 'pending close retained before and after restoration', 'executed closes remove only their reference', 'no overflow', 'no drawing when off'] })
    } catch (error) { await page.screenshot({ path: `${output}/failure-${width}.png` }); throw error }
    finally { await context.close() }
    // Restore the fixture for the second viewport without changing user data.
    if (width === 1100) {
      const saved = (await storage.list()).sessions.find(record => record.id === id)!
      globalThis.fetch = ((path: string, init?: RequestInit) => nativeFetch(`${apiOrigin}${path}`, { ...init, headers: { Origin: apiOrigin, ...init?.headers } })) as typeof fetch
      try { await new DiskSessionStore().save(saved, { ledger, checkpoint: { ...saved.checkpoint, trading: state, equity: equitySummary(ledger), executionCursor: 811, replay: { ...saved.checkpoint.replay, index: 810, timestamp: bid[810].timestamp } } }, saved) }
      finally { globalThis.fetch = nativeFetch }
    }
  }
  await writeFile(`${output}/browser-verification.json`, JSON.stringify(reports, null, 2) + '\n')
  console.log(JSON.stringify(reports, null, 2))
} finally { await browser.close(); await new Promise<void>(resolve => server.httpServer.close(() => resolve())); await new Promise<void>(resolve => { api.close(() => resolve()); api.closeAllConnections() }); await storage.close() }
