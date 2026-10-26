import '../backend/src/environment.js'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'
import { createApp } from '../backend/src/app.js'
import { LocalArchive } from '../backend/src/localArchive.js'
import { SessionStorage } from '../backend/src/sessionStorage.js'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core')
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/home/admin/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome', headless: true, args: ['--no-sandbox'] })
const output = 'docs/365-day-backtests'
await mkdir(output, { recursive: true })
const reports: unknown[] = []
try {
  for (const width of [1100, 1440]) {
    const directory = await mkdtemp(join(tmpdir(), `forextester-year-${width}-`)), storage = new SessionStorage({ directory }), archive = new LocalArchive()
    const api = createApp(archive, undefined, storage)
    await new Promise<void>(done => api.listen(0, '127.0.0.1', done))
    const apiOrigin = `http://127.0.0.1:${(api.address() as { port: number }).port}`
    const vite = await createServer({ configFile: false, root: resolve('frontend'), server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: apiOrigin, changeOrigin: false } } } })
    await vite.listen()
    const origin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`
    const context = await browser.newContext({ viewport: { width, height: width === 1100 ? 800 : 1000 } })
    await context.addInitScript(() => { globalThis.__forexReplayPerformance = { samples: {}, counts: {} } })
    const page = await context.newPage(), errors: string[] = [], external: string[] = []
    const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable')
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => { if (!request.url().startsWith(origin) && !request.url().startsWith('data:')) external.push(request.url()) })
    page.on('dialog', dialog => dialog.accept())
    try {
      await page.goto(origin)
      await page.getByRole('button', { name: '365 days', exact: true }).waitFor()
      await page.waitForFunction(() => !(document.querySelector('.workspace-controls') as HTMLFieldSetElement)?.disabled)
      await page.waitForFunction(() => !(Array.from(document.querySelectorAll('button')).find(button => button.textContent === '365 days') as HTMLButtonElement)?.disabled)
      assert.equal(await page.getByRole('button', { name: '365 days', exact: true }).isDisabled(), false)
      await page.getByRole('button', { name: '365 days', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('[aria-label="Historical start date"]')?.getAttribute('max') === '394')
      const timeline = await page.evaluate(() => ({
        start: { value: (document.querySelector('[aria-label="Historical start date"]') as HTMLInputElement).value, max: (document.querySelector('[aria-label="Historical start date"]') as HTMLInputElement).max },
        end: { value: (document.querySelector('[aria-label="Historical end date"]') as HTMLInputElement).value, max: (document.querySelector('[aria-label="Historical end date"]') as HTMLInputElement).max },
        dates: document.querySelector('.selected-dates')?.textContent, scale: document.querySelector('.timeline-scale')?.textContent,
      }))
      assert.deepEqual(timeline.start, { value: '30', max: '394' }); assert.deepEqual(timeline.end, { value: '394', max: '394' })
      assert((await page.locator('.period-shortcuts').innerText()).includes('365 calendar days · maximum 365'))
      await page.screenshot({ path: `${output}/setup-${width}.png`, fullPage: true })
      const started = performance.now()
      await page.getByRole('button', { name: 'Start backtest', exact: true }).click()
      await page.locator('.phase-trading').waitFor({ timeout: 120000 })
      const tradingReadyMs = performance.now() - started
      await page.waitForFunction(() => document.querySelector('.save-state')?.textContent === 'Saved', undefined, { timeout: 120000 })
      const savedMs = performance.now() - started
      await page.locator('input[name="chart-count"][value="3"]').check()
      const replay: Record<string, unknown> = {}
      for (const speed of [1, 10, 100]) {
        await page.getByLabel('Replay speed').selectOption(String(speed))
        const before = Number((await page.getByLabel('Replay progress').textContent())!.split('/')[0]), target = before + speed * 4
        const tick = performance.now(); await page.getByRole('button', { name: 'Play', exact: true }).click()
        await page.waitForFunction(target => Number(document.querySelector('[aria-label="Replay progress"]')!.textContent!.split('/')[0]) >= target, target, { timeout: 10000 })
        await page.getByRole('button', { name: 'Pause', exact: true }).click()
        replay[`${speed}x`] = { elapsedMs: performance.now() - tick, observations: Number((await page.getByLabel('Replay progress').textContent())!.split('/')[0]) - before }
      }
      await page.waitForFunction(() => document.querySelector('.save-state')?.textContent === 'Saved', undefined, { timeout: 30000 })
      const loadBrowserMetrics = await page.evaluate(() => ({
        resource: performance.getEntriesByType('resource').map(entry => ({ name: entry.name, duration: entry.duration, transferSize: (entry as PerformanceResourceTiming).transferSize,
          encodedBodySize: (entry as PerformanceResourceTiming).encodedBodySize, decodedBodySize: (entry as PerformanceResourceTiming).decodedBodySize })).find(entry => entry.name.includes('/api/history?')),
        heap: (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory
          ? { usedJSHeapSize: (performance as any).memory.usedJSHeapSize, totalJSHeapSize: (performance as any).memory.totalJSHeapSize, jsHeapSizeLimit: (performance as any).memory.jsHeapSizeLimit } : null,
      }))
      const loadCdp = await cdp.send('Performance.getMetrics')
      const beforeReload = (await storage.list()).sessions[0]
      const reloadStarted = performance.now(); await page.reload()
      await page.getByRole('button', { name: 'Resume backtest', exact: true }).click()
      await page.locator('.phase-trading').waitFor({ timeout: 120000 })
      await page.waitForFunction(() => !(document.querySelector('.workspace-controls') as HTMLFieldSetElement)?.disabled, undefined, { timeout: 120000 })
      const restoreMs = performance.now() - reloadStarted
      assert.equal(await page.getByLabel('Replay status').textContent(), 'Paused')
      assert.equal((await storage.list()).sessions[0].checkpoint.replay.timestamp, beforeReload.checkpoint.replay.timestamp)
      const finishStarted = performance.now(); await page.getByRole('button', { name: 'Finish backtest', exact: true }).click()
      await page.locator('.phase-finished').waitFor({ timeout: 30000 })
      await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
      const resultsRenderMs = performance.now() - finishStarted
      assert(await page.locator('.results-account-chart h3').isVisible())
      assert(await page.getByRole('img', { name: /Balance and equity over UTC time/ }).isVisible())
      await page.screenshot({ path: `${output}/results-${width}.png`, fullPage: true })
      const browserMetrics = await page.evaluate(() => ({
        replay: globalThis.__forexReplayPerformance,
        heap: (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory
          ? { usedJSHeapSize: (performance as any).memory.usedJSHeapSize, totalJSHeapSize: (performance as any).memory.totalJSHeapSize, jsHeapSizeLimit: (performance as any).memory.jsHeapSizeLimit } : null,
        overflow: document.documentElement.scrollWidth > window.innerWidth,
      }))
      const cdpMetrics = await cdp.send('Performance.getMetrics')
      reports.push({ width, height: width === 1100 ? 800 : 1000, timeline, tradingReadyMs, savedMs, restoreMs, resultsRenderMs, replay,
        historyRequest: loadBrowserMetrics.resource, browserHeapAfterLoad: loadBrowserMetrics.heap, browserHeapAfterResults: browserMetrics.heap,
        cdpAfterLoad: Object.fromEntries(loadCdp.metrics.filter(metric => ['JSHeapUsedSize','JSHeapTotalSize','Nodes','LayoutCount','RecalcStyleCount'].includes(metric.name)).map(metric => [metric.name, metric.value])),
        cdpAfterResults: Object.fromEntries(cdpMetrics.metrics.filter(metric => ['JSHeapUsedSize','JSHeapTotalSize','Nodes','LayoutCount','RecalcStyleCount'].includes(metric.name)).map(metric => [metric.name, metric.value])),
        backendPeakRssMiB: process.resourceUsage().maxRSS / 1024, performance: browserMetrics.replay, overflow: browserMetrics.overflow,
        session: { range: beforeReload.range, totalCandles: beforeReload.totalCandles, replayTimestamp: beforeReload.checkpoint.replay.timestamp, revision: beforeReload.revision }, external, errors })
      assert.equal(browserMetrics.overflow, false); assert.deepEqual(external, []); assert.deepEqual(errors, [])
    } finally {
      await context.close(); await vite.close(); await new Promise<void>(done => { api.close(() => done()); api.closeAllConnections() }); await storage.close()
      await delay(20)
    }
  }
  await writeFile(`${output}/browser-verification.json`, JSON.stringify(reports, null, 2) + '\n')
  console.log(JSON.stringify(reports, null, 2))
} finally { await browser.close() }
