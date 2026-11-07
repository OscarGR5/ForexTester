// One 1440px smoke check of the production App, using isolated synthetic storage.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { build, preview } from 'vite'
import { benchmarkHistory } from './chart-replay-data'
import { DiskSessionStore } from '../frontend/src/diskSessionStore'
import { historyFingerprint } from '../frontend/src/sessionCodec'
import { sessionSimulation } from '../frontend/src/sessionFixtures'
import { defaultIndicatorSettings } from '../frontend/src/indicators'
import { defaultWorkspace, selectChartMode } from '../frontend/src/uiPreferences'
import { createTradingState, observeCandle } from '../frontend/src/trading'
import { createEquityLedger, recordEquity } from '../frontend/src/equity'
import { equitySummary } from '../frontend/src/sessionTypes'
import { ReplayBars } from '../frontend/src/replayBars'
import { UntakenLevels } from '../frontend/src/untakenLevels'
import { TIMEFRAME_MS, type Timeframe } from '../frontend/src/history'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core')
const directory = await mkdtemp(join(tmpdir(), 'untaken-smoke-'))
const harness = await mkdtemp(join(resolve('frontend'), '.untaken-smoke-'))
const output = '/tmp/forextester-untaken-levels', api = 'http://127.0.0.1:3019'
await mkdir(output, { recursive: true })
const nativeFetch = globalThis.fetch
let child: ReturnType<typeof spawn> | undefined, server: Awaited<ReturnType<typeof preview>> | undefined, browser: any
try {
  child = spawn(process.execPath, ['--import', 'tsx', 'backend/src/server.ts'], { env: { ...process.env, FOREXTESTER_DATA_DIR: directory, PORT: '3019' }, stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise<void>((resolve, reject) => { child!.stdout!.once('data', () => resolve()); child!.once('exit', code => reject(Error(`Backend exited ${code}`))); child!.stderr!.on('data', d => process.stderr.write(d)) })
  globalThis.fetch = ((path: string, init?: RequestInit) => nativeFetch(api + path, { ...init, headers: { Origin: api, ...init?.headers } })) as typeof fetch
  const history = benchmarkHistory(2), source = history.bid, start = source.findIndex(c => c.timestamp >= Date.parse(history.tradingFrom)) + 61
  // Seed a candidate high and low that must stay hidden until the right M5 candle closes.
  const beforeSeed = new ReplayBars('M5'); beforeSeed.advance(source, start + 1)
  const left = beforeSeed.candles.slice(-2, -1)
  source[start].high = Math.max(source[start].high, ...left.map(c => c.high + 0.00001))
  source[start].low = Math.min(source[start].low, ...left.map(c => c.low - 0.00001))
  history.ask[start].high = source[start].high + 0.0002
  history.ask[start].low = source[start].low + 0.0002
  const initialBars = new ReplayBars('M5'); initialBars.advance(source, start + 1)
  const latest = initialBars.candles.at(-1)!
  // Equal M5 candles extend a hidden plateau. A weaker closed right M5
  // confirms it, then an equal forming touch invalidates both confirmed rays.
  for (let i = start + 1; i <= start + 19; i++) {
    const elapsed = source[i].timestamp - latest.time * 1000
    const weaker = elapsed >= 15 * 60000 && elapsed < 20 * 60000
    Object.assign(source[i], { open: latest.close, close: latest.close,
      high: weaker ? (latest.high + latest.close) / 2 : latest.high,
      low: weaker ? (latest.low + latest.close) / 2 : latest.low })
    Object.assign(history.ask[i], { open: latest.close + 0.0002, close: latest.close + 0.0002,
      high: source[i].high + 0.0002, low: source[i].low + 0.0002 })
  }
  // The first observation of the next M5 candle takes both confirmed levels.
  Object.assign(source[start + 20], { open: latest.close, close: latest.close, high: latest.high, low: latest.low })
  Object.assign(history.ask[start + 20], { open: latest.close + 0.0002, close: latest.close + 0.0002,
    high: latest.high + 0.0002, low: latest.low + 0.0002 })
  const simulation = sessionSimulation(history); simulation.observe(0)
  const snapshot = simulation.snapshot(), initial = createTradingState(7, undefined, { roundTripUsdPerLot: 7 })
  const state = observeCandle(initial, source[start], history.ask[start]), ledger = recordEquity(createEquityLedger(initial.account.referenceBalance), initial, state)
  Object.assign(snapshot.checkpoint, { trading: state, equity: equitySummary(ledger), executionCursor: start + 1 })
  Object.assign(snapshot.checkpoint.replay, { index: start, timestamp: source[start].timestamp, startIndex: start, startTimestamp: source[start].timestamp })
  snapshot.ledger = ledger
  snapshot.checkpoint.workspace = selectChartMode(defaultWorkspace(), 4)
  snapshot.checkpoint.workspace.indicators = snapshot.checkpoint.workspace.timeframes.map(tf => ({ [tf]: defaultIndicatorSettings() }))
  const store = new DiskSessionStore(), historyId = await historyFingerprint(history)
  await store.cacheHistory(historyId, history)
  await store.save({ id: crypto.randomUUID(), name: 'Untaken smoke', createdAt: new Date().toISOString(), range: { from: history.tradingFrom, to: history.to }, totalCandles: source.length, historyId }, snapshot, null)
  globalThis.fetch = nativeFetch

  // Test-only hooks observe the primitive's public lifecycle and canvas paint
  // order. The App, charts, keyboard, replay and persistence code are unchanged.
  await writeFile(join(harness, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="./entry.tsx"></script></body></html>')
  await writeFile(join(harness, 'entry.tsx'), `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { App } from '/src/App'; import { UntakenLevelsPrimitive } from '/src/UntakenLevelsPrimitive'; import '/src/style.css';
    const records = new Map(), elements = new Map();
    const proto = UntakenLevelsPrimitive.prototype, attach = proto.attached, detach = proto.detached, set = proto.setData;
    proto.attached = function(p) { elements.set(this, p.chart.chartElement()); attach.call(this, p); };
    proto.detached = function() { elements.delete(this); records.delete(this); detach.call(this); };
    proto.setData = function(levels) { records.set(this, levels); set.call(this, levels); };
    window.rays = () => [...records].map(([instance, levels]) => ({ timeframe: elements.get(instance).closest('.chart-pane').querySelector('select').value, levels }));
    createRoot(document.getElementById('root')).render(React.createElement(App));
  `)
  await build({ configFile: false, root: 'frontend', logLevel: 'warn', build: { outDir: join(directory, 'dist'), emptyOutDir: true, rollupOptions: { input: join(harness, 'index.html') } } })
  server = await preview({ configFile: false, root: 'frontend', build: { outDir: join(directory, 'dist') }, preview: { host: '127.0.0.1', port: 5199, strictPort: true, proxy: { '/api': { target: api } } } })
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? '/home/admin/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell' })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    const w = window as any; w.paint = []
    const proto = CanvasRenderingContext2D.prototype, stroke = proto.stroke, fill = proto.fillRect
    proto.stroke = function(...args: any[]) {
      if (['#ef5350', '#26a69a'].includes(String(this.strokeStyle))) w.paint.push({ kind: 'ray', color: this.strokeStyle, canvas: this.canvas })
      return (stroke as any).apply(this, args)
    }
    proto.fillRect = function(...args: any[]) {
      if (['#ffffff', '#2962ff'].includes(String(this.fillStyle))) w.paint.push({ kind: 'candle', canvas: this.canvas })
      return (fill as any).apply(this, args)
    }
  })
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  await page.goto(`http://127.0.0.1:5199/${harness.split('/').at(-1)}/index.html`)
  await page.getByRole('button', { name: 'Resume backtest', exact: true }).click()
  await page.locator('.phase-trading .chart-pane').nth(3).waitFor()
  await page.getByRole('button', { name: 'Regression', exact: true }).click()
  await page.locator('.chart-canvas').nth(2).click({ position: { x: 200, y: 100 }, modifiers: ['Control'] })
  const snapshotRays = () => page.evaluate(() => (window as any).rays())
  const expected = (count: number, timeframe: Timeframe, limit = 10) => {
    const bars = new ReplayBars(timeframe); bars.advance(source, count)
    const tail = bars.candles.at(-1)!, completed = bars.candles.length - (source[count - 1].timestamp + 60000 < tail.time * 1000 + TIMEFRAME_MS[timeframe] ? 1 : 0)
    const levels = new UntakenLevels(); levels.update(bars.candles, completed)
    return levels.visible(tail.close, limit)
  }
  const verify = async (count: number, limit = 10) => {
    const values = await snapshotRays()
    assert.equal(values.length, 4)
    for (const pane of values) {
      assert.deepEqual(pane.levels, expected(count, pane.timeframe, limit))
      for (const side of ['high', 'low']) {
        const levels = pane.levels.filter((level: any) => level.side === side)
        assert.ok(levels.length <= limit)
        assert.equal(new Set(levels.map((level: any) => level.price)).size, levels.length)
        assert.ok(levels.every((level: any) => side === 'high' ? level.price > source[count - 1].close : level.price < source[count - 1].close))
      }
    }
    return values
  }
  assert.ok((await snapshotRays()).every((p: any) => p.levels.length === 0))
  assert.equal(await page.getByLabel('Chart 3 Untaken Levels', { exact: true }).inputValue(), '10')
  assert.equal(await page.getByLabel('Chart 3 Pivot Strength', { exact: true }).count(), 0)
  await page.evaluate(() => { (window as any).paint = [] })
  await page.keyboard.press('p'); await page.waitForTimeout(150)
  const initialRays = await verify(start + 1)
  // No ray may originate at the last M5 candle before a closed right neighbor.
  const latestM5 = initialRays.find((p: any) => p.timeframe === 'M5')
  assert.ok(latestM5)
  assert.ok(latestM5.levels.every((l: any) => l.time !== latest.time))
  const hasSeed = (panes: any[]) => {
    const levels = panes.find(p => p.timeframe === 'M5').levels
    return ['high', 'low'].every(side => levels.some((l: any) => l.side === side && l.price === latest[side] && l.time === latest.time))
  }
  for (let i = 0; i < 12; i++) await page.getByRole('button', { name: 'Next Min', exact: true }).click()
  assert.equal(hasSeed(await verify(start + 13)), false)
  // The weaker M5 right candle spans :15–:19; its close at :19 confirms
  // the seeded pivot. The next M5 starts at :20 and touches it immediately.
  await page.evaluate(() => { (window as any).paint = [] })
  for (let i = 0; i < 6; i++) await page.getByRole('button', { name: 'Next Min', exact: true }).click()
  const confirmed = await verify(start + 19)
  assert.equal(hasSeed(confirmed), true)
  const paint = await page.evaluate(() => {
    const events = (window as any).paint
    return { colors: [...new Set(events.filter((p: any) => p.kind === 'ray').map((p: any) => p.color))],
      behind: events.some((p: any, i: number) => p.kind === 'ray' && events.slice(i + 1).some((c: any) => c.kind === 'candle' && c.canvas === p.canvas)) }
  })
  assert.deepEqual(paint.colors.sort(), ['#26a69a', '#ef5350']); assert.equal(paint.behind, true)
  await page.screenshot({ path: join(output, 'four-charts-1440.png'), fullPage: true })
  await page.getByRole('button', { name: 'Next Min', exact: true }).click()
  const advanced = await verify(start + 20)
  assert.equal(hasSeed(advanced), false)
  await page.locator('.chart-canvas').nth(2).click({ position: { x: 200, y: 100 } })
  await page.keyboard.press('Control+Shift+ArrowLeft'); assert.equal(hasSeed(await verify(start + 19)), true)
  await page.keyboard.press('Control+Shift+ArrowRight'); assert.equal(hasSeed(await verify(start + 20)), false)
  await page.locator('.indicator-controls summary').nth(2).click()
  await page.getByLabel('Chart 3 Untaken Levels', { exact: true }).fill('1')
  const narrow = await verify(start + 20, 1)
  assert.ok(narrow.reduce((sum: number, p: any) => sum + p.levels.length, 0) < advanced.reduce((sum: number, p: any) => sum + p.levels.length, 0))
  await page.getByLabel('Chart 3 Untaken Levels', { exact: true }).fill('15'); await verify(start + 20, 15)
  await page.getByLabel('Chart 3 Untaken Levels', { exact: true }).press('p'); await verify(start + 20, 15) // Input guard.
  await page.keyboard.press('Escape')
  await page.locator('.chart-canvas').nth(2).click({ position: { x: 200, y: 100 } })
  await page.mouse.wheel(0, -100); await verify(start + 20, 15)
  await page.getByLabel('Chart 3 timeframe', { exact: true }).selectOption('M15'); await verify(start + 20, 15)
  await page.keyboard.press('p'); assert.ok((await snapshotRays()).every((p: any) => p.levels.length === 0))
  await page.keyboard.press('p'); await verify(start + 20, 15)
  await page.reload(); await page.getByRole('button', { name: 'Resume backtest', exact: true }).click()
  await page.locator('.phase-trading .chart-pane').nth(3).waitFor()
  assert.ok((await snapshotRays()).some((p: any) => p.levels.length > 0))
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('forextester:ui:v1:global')!).untakenLevels.count), 15)
  assert.equal(await page.getByLabel('Chart 3 Pivot Strength', { exact: true }).count(), 0)
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('forextester:ui:v1:global')!).untakenLevels), { enabled: true, count: 15 })
  assert.deepEqual(errors, [])
  const evidence = { viewport: '1440 × 1000', checks: ['red/green rays', 'painted before candles', 'coexists with regression', 'P and input focus guard', 'equal high/low plateaus retain first anchors', 'weaker close confirmation then exact-touch invalidation', 'backward reconstruction', 'independent H1/D1/M5/H4 calculations', 'no rays from a last-candle extreme', 'immediate per-side count updates', 'level-count persistence and removed strength control', 'zoom invariance', 'timeframe recalculation', 'reload persistence'], initialCounts: initialRays.map((p: any) => [p.timeframe, p.levels.length]), paint, errors }
  await writeFile(join(output, 'smoke.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence))
} finally {
  globalThis.fetch = nativeFetch
  await browser?.close(); await server?.httpServer.close()
  if (child && child.exitCode === null) { child.kill('SIGKILL'); await new Promise<void>(resolve => child!.once('exit', () => resolve())) }
  await rm(harness, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true })
}
