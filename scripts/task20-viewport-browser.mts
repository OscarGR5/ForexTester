// Run with node --import tsx scripts/task20-viewport-browser.mts.
// REPRESENTATIVE=1 uses deterministic weekday history; default uses Dukascopy.
// Chart API handles are exposed only by this verification server's transform.
import { chromium } from 'playwright-core'
import { createServer } from 'vite'
import { createApp } from '../backend/src/app'
import { SessionStorage } from '../backend/src/sessionStorage'
import { benchmarkHistory } from './chart-replay-data'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const directory = await mkdtemp(join(tmpdir(), 'forextester-viewport-'))
const representative = process.env.REPRESENTATIVE === '1'
const fixture = representative ? benchmarkHistory(2) : null
let historyRequests = 0
const api = createApp(fixture ? async config => {
  const candles = config.priceType === 'ask' ? fixture.ask : fixture.bid
  return candles.filter(c => c.timestamp >= +config.dates.from && c.timestamp < +config.dates.to)
} : undefined, undefined, new SessionStorage({ directory }))
await new Promise<void>(r => api.listen(0, '127.0.0.1', r))
const port = (api.address() as { port: number }).port
const vite = await createServer({ configFile: false, root: 'frontend', cacheDir: join(directory, 'vite-cache'),
  optimizeDeps: { include: ['react', 'react-dom', 'react-dom/client', 'lightweight-charts', 'technicalindicators'] },
  server: { watch: null, hmr: false, host: '127.0.0.1', port: 5191, strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${port}`, changeOrigin: false } } },
  plugins: [{ name: 'viewport-verification-handles', enforce: 'pre', transform(code, id) {
    if (!id.endsWith('/src/ChartPane.tsx')) return
    return code.replace('unregisterRef.current = unregister', `
      globalThis.__viewportCharts ??= new Map();
      globalThis.__viewportCharts.set(id, { chart, price: series, sync: synchronizer });
      unregisterRef.current = unregister`)
  } }],
})
await vite.listen()
const browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors: string[] = [], evidence: any = { source: representative ? 'deterministic weekday historical fixture' : 'Dukascopy EURUSD bid/ask M1', viewport: { width: 1440, height: 900 }, initial: {} }
page.on('pageerror', e => errors.push(e.message))
page.on('request', r => { if (new URL(r.url()).pathname === '/api/history') historyRequests++ })
await page.addInitScript(`
  globalThis.__name = (target) => target;
  globalThis.__forexReplayPerformance = { samples: {}, counts: {} };
  if (localStorage.getItem('viewport-test-reset')) {
    localStorage.removeItem('viewport-test-reset');
    for (const key of Object.keys(localStorage)) if (key.startsWith('forextester:ui:v1:')) {
      const envelope = JSON.parse(localStorage.getItem(key));
      if (envelope.workspace) { envelope.workspace.viewport = null; localStorage.setItem(key, JSON.stringify(envelope)); }
    }
  }
`)
const button = (name: string) => page.getByRole('button', { name, exact: true })
const settle = async () => {
  await page.locator('.chart-canvas').first().waitFor()
  await page.waitForTimeout(350) // Lightweight Charts' asynchronous range notifications and paint.
}
const screenshot = (name: string) => page.screenshot({ path: `docs/task-20/${name}.png`, fullPage: true })
async function read() {
  const charts = await page.evaluate(() => {
    const replayEdge = Date.parse(document.querySelector('.replay-clock')!.textContent!.replace(' UTC', 'Z').replace(' ', 'T')) / 1000
    return [...(globalThis as any).__viewportCharts.entries()]
      .filter(([id]) => id < document.querySelectorAll('.chart-canvas').length)
      .map(([id, { chart, price, sync }]: any) => {
        const data = price.data(), range = chart.timeScale().getVisibleLogicalRange(), view = sync.snapshot()
        const visible = data.filter((_: any, i: number) => i >= Math.ceil(range.from) && i <= Math.floor(range.to))
        const tail = data.at(-1), previous = data.at(-2)
        const spacing = chart.timeScale().timeToCoordinate(tail.time) - chart.timeScale().timeToCoordinate(previous.time)
        const projected = chart.panes().flatMap((p: any) => p.getSeries()).filter((s: any) => s !== price)
          .flatMap((s: any) => s.data()).filter((p: any) => p.time > tail.time && p.value !== undefined)
        return { id, range, view, installed: data.length, first: data[0].time, last: tail.time,
          visible: visible.length, spacing, projected: projected.length,
          replayEdge, futurePrices: data.filter((c: any) => c.time > replayEdge).length,
          bodyPixels: visible.filter((c: any) => Math.abs(price.priceToCoordinate(c.open) - price.priceToCoordinate(c.close)) >= 2).length,
          wickPixels: visible.filter((c: any) => Math.abs(price.priceToCoordinate(c.high) - price.priceToCoordinate(c.low)) >= 4).length }
      })
  })
  assert.ok(charts.every(c => c.futurePrices === 0), 'no chart contains an unrevealed price candle')
  return charts
}
async function reload(reset = false) {
  if (reset) await page.evaluate(() => localStorage.setItem('viewport-test-reset', '1'))
  await page.reload()
  await button('Resume session').click()
  await settle()
}
try {
  await page.goto('http://127.0.0.1:5191')
  await page.waitForFunction(() => !document.querySelector<HTMLFieldSetElement>('.workspace-controls')?.disabled)
  await page.getByLabel('Backtest name', { exact: true }).fill('Initial viewport review')
  const date = fixture?.tradingFrom ?? '2024-01-09'
  await page.getByLabel('From', { exact: true }).fill(date)
  await page.getByLabel('Through', { exact: true }).fill(date)
  assert.equal(historyRequests, 0)
  await button('Load historical data').click()
  await page.waitForFunction(() => document.querySelector('.data-ready') || document.querySelector('.load-error'), {}, { timeout: 300000 })
  assert.equal(await page.locator('.load-error').count(), 0, await page.locator('body').innerText())
  await button('Start backtest').click()
  await settle()
  await page.waitForFunction(() => document.querySelector('.save-state')?.textContent === 'Saved')
  const initial = (await read())[0]
  evidence.initial.M1 = initial
  assert.ok(initial.installed > 20000, '30-day pre-roll remains installed')
  assert.ok(initial.visible >= 150 && initial.visible <= 250)
  assert.ok(initial.spacing >= 5, 'candles have several horizontal pixels each')
  assert.ok(initial.bodyPixels > 50 && initial.wickPixels > 100, 'distinct bodies and wicks')
  assert.equal(initial.futurePrices, 0)
  assert.equal(initial.last, initial.view.range.to)
  await screenshot(representative ? 'trading-viewport-representative' : 'trading-live')
  const before = initial.view.range
  const countsBefore = await page.evaluate(() => ({ ...globalThis.__forexReplayPerformance!.counts }))
  await button('Next Candle').click()
  await settle()
  const advanced = (await read())[0]
  assert.equal(advanced.view.range.to, before.to + 60)
  assert.equal(advanced.view.range.to - advanced.view.range.from, before.to - before.from)
  const countsAfter = await page.evaluate(() => ({ ...globalThis.__forexReplayPerformance!.counts }))
  assert.equal(countsAfter['candles.setData'], countsBefore['candles.setData'], 'ordinary replay stays incremental')
  evidence.following = { before, after: advanced.view.range, incremental: true }

  const loadedRequests = historyRequests
  for (const tf of ['M5', 'M15', 'H1', 'H4']) {
    await page.getByLabel('Chart 1 timeframe', { exact: true }).selectOption(tf)
    await reload(true) // No saved range: selected timeframe chooses its initial span.
    const result = (await read())[0]
    assert.ok(result.visible >= Math.min(195, result.installed) && result.visible <= 201)
    assert.equal(result.futurePrices, 0)
    assert.equal(result.view.range.to, advanced.view.range.to)
    if (tf === 'H1' || tf === 'H4') assert.ok(result.projected > 0, 'Ichimoku projection survives')
    evidence.initial[tf] = result
  }
  await page.getByLabel('Chart 1 timeframe', { exact: true }).selectOption('M5')
  await reload(true)
  await page.locator('input[name="chart-count"][value="3"]').check()
  await page.getByLabel('Chart 2 timeframe', { exact: true }).selectOption('M15')
  await page.getByLabel('Chart 3 timeframe', { exact: true }).selectOption('H4')
  await settle()
  const mixed = await read()
  assert.equal(mixed.length, 3)
  assert.ok(mixed.every(c => JSON.stringify(c.view) === JSON.stringify(mixed[0].view) && c.futurePrices === 0))
  assert.ok(mixed[2].projected > 0)
  evidence.mixed = mixed
  await screenshot(`trading-viewport-mixed${representative ? '-representative' : ''}`)
  const box = await page.locator('.chart-canvas').first().boundingBox(); assert.ok(box)
  await page.mouse.move(box.x + box.width * .6, box.y + box.height * .4)
  await page.mouse.wheel(0, -200)
  await settle()
  const zoomed = await read()
  assert.notDeepEqual(zoomed[0].view.range, mixed[0].view.range)
  assert.ok(zoomed.every(c => JSON.stringify(c.view) === JSON.stringify(zoomed[0].view)))
  assert.ok(await page.evaluate(() => globalThis.__forexReplayPerformance!.counts['sync.crosshair.set'] > 0))
  evidence.synchronizedZoom = zoomed
  // Drag right to navigate away from replay. This must persist through replay and refresh.
  await page.mouse.move(box.x + box.width * .4, box.y + box.height * .4)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * .75, box.y + box.height * .4, { steps: 12 })
  await page.mouse.up()
  await settle()
  const manual = (await read())[0].view
  assert.equal(manual.following, false)
  await button('Next Candle').click()
  await settle()
  assert.deepEqual((await read())[0].view, manual)
  await reload()
  assert.deepEqual((await read())[0].view, manual)
  assert.equal(historyRequests, loadedRequests, 'restoration uses saved data without downloading')
  evidence.restoredCustom = { view: manual, charts: await read(), historyRequests }
  await screenshot(`trading-viewport-restored${representative ? '-representative' : ''}`)
  // Public API verification: navigate to the earliest installed M1 prices.
  await page.locator('input[name="chart-count"][value="1"]').check()
  await page.getByLabel('Chart 1 timeframe', { exact: true }).selectOption('M1')
  await settle()
  await page.evaluate(() => {
    const { chart, sync } = (globalThis as any).__viewportCharts.get(0)
    sync.activate(0); chart.timeScale().setVisibleLogicalRange({ from: 0, to: 199 })
  })
  await settle()
  const oldest = (await read())[0]
  assert.equal(oldest.view.range.from, oldest.first)
  assert.equal(oldest.installed, initial.installed + 2)
  evidence.oldestHistory = oldest
  assert.deepEqual(errors, [])
  evidence.errors = errors
  evidence.sandbox = true
  await writeFile(`docs/task-20/viewport-${representative ? 'representative' : 'live'}-verification.json`, JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence, null, 2))
} catch (error) {
  await screenshot('viewport-failure')
  throw error
} finally {
  await browser.close(); await vite.close(); await new Promise<void>(r => api.close(() => r()))
  await rm(directory, { recursive: true, force: true })
}
