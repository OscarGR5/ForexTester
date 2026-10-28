// Real Chromium gestures against the production App and ChartPane. All history
// and session writes belong to a disposable server, never the user's archive.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'
import { createApp } from '../backend/src/app.js'
import { SessionStorage } from '../backend/src/sessionStorage.js'
import { DiskSessionStore } from '../frontend/src/diskSessionStore.js'
import { historyFingerprint } from '../frontend/src/sessionCodec.js'
import { sessionSimulation } from '../frontend/src/sessionFixtures.js'
import { defaultWorkspace, selectChartMode } from '../frontend/src/uiPreferences.js'
import { benchmarkHistory } from './chart-replay-data.js'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core')
const output = process.env.BROWSER_OUTPUT ?? 'docs/chart-viewport/after'
await mkdir(output, { recursive: true })
const directory = await mkdtemp(join(tmpdir(), 'forextester-viewport-'))
const storage = new SessionStorage({ directory })
// Only cached session history is used. Archive discovery returns an empty set.
const archive = { datasets: async () => ({ datasets: [] }), calendar: async () => ({ days: [] }) }
const api = createApp(archive as any, undefined, storage)
await new Promise<void>(done => api.listen(0, '127.0.0.1', done))
const apiOrigin = `http://127.0.0.1:${(api.address() as { port: number }).port}`
const nativeFetch = globalThis.fetch
const history = benchmarkHistory(3)
const tradingStart = history.bid.findIndex(c => c.timestamp >= Date.parse(history.tradingFrom))
const sim = sessionSimulation({ ...history, bid: history.bid.slice(tradingStart), ask: history.ask.slice(tradingStart) })
sim.observe(100)
const snapshot = sim.snapshot()
snapshot.checkpoint.replay.startIndex = tradingStart
snapshot.checkpoint.replay.startTimestamp = history.bid[tradingStart].timestamp
snapshot.checkpoint.replay.index! += tradingStart
snapshot.checkpoint.executionCursor += tradingStart
snapshot.checkpoint.workspace = selectChartMode(defaultWorkspace(), 1)
snapshot.checkpoint.workspace.timeframes[0] = 'H1'
snapshot.checkpoint.workspace.indicators[0].H1 = snapshot.checkpoint.workspace.indicators[2].H1!
const id = randomUUID()
try {
  globalThis.fetch = ((path: string, init?: RequestInit) => nativeFetch(`${apiOrigin}${path}`, { ...init, headers: { Origin: apiOrigin, ...init?.headers } })) as typeof fetch
  const store = new DiskSessionStore(), historyId = await historyFingerprint(history)
  await store.cacheHistory(historyId, history)
  await store.save({ id, name: 'Viewport regression', createdAt: new Date().toISOString(), range: { from: history.tradingFrom, to: history.to }, totalCandles: history.bid.length, historyId }, snapshot, null)
} finally { globalThis.fetch = nativeFetch }

const vite = await createServer({ configFile: false, root: resolve('frontend'), cacheDir: join(directory, 'vite'),
  plugins: [{ name: 'test-only-chart-probe', transform(code, path) {
    if (!path.endsWith('/src/ChartPane.tsx')) return
    // Observe public chart APIs without adding any hooks to the shipped app.
    return code.replace('chartRef.current = chart', '(globalThis.__charts ??= {})[id] = { chart, series }; chartRef.current = chart')
      .replace('const unregister = synchronizer.register', '(globalThis.__charts ??= {})[id].sync = synchronizer; const unregister = synchronizer.register')
  } }], server: { host: '127.0.0.1', port: 0, hmr: false, proxy: { '/api': { target: apiOrigin } } } })
await vite.listen()
const origin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/home/admin/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome', headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors: string[] = [], external: string[] = [], reports: unknown[] = []
page.on('pageerror', e => { errors.push(e.message); console.error(e.message) })
await page.route('**/*', route => {
  if (!route.request().url().startsWith(origin)) { external.push(route.request().url()); return route.abort() }
  // Never discover or download real market data in this regression.
  if (/\/api\/history\//.test(route.request().url())) return route.fulfill({ json: { datasets: [], days: [] } })
  return route.continue()
})
const settle = () => page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => done())))))
const read = (pane = 0) => page.evaluate(id => {
  const { chart, series, sync } = (globalThis as any).__charts[id]
  const scale = chart.timeScale(), range = scale.getVisibleLogicalRange(), data = series.data()
  const visible = data.filter((c: any, i: number) => i >= range.from && i <= range.to && series.priceToCoordinate(c.close) >= 0 && series.priceToCoordinate(c.close) <= chart.panes()[0].getHeight())
  return { range, span: range.to - range.from, barSpacing: scale.options().barSpacing, plotWidth: scale.width(), timeHeight: scale.height(), height: chart.panes()[0].getHeight(),
    last: data.length - 1, lastX: scale.timeToCoordinate(data.at(-1).time), lastY: series.priceToCoordinate(data.at(-1).close), visible: visible.length,
    price: series.priceScale().getVisibleRange(), autoScale: series.priceScale().options().autoScale, view: sync.snapshot().charts[id] }
}, pane)
const shot = (name: string) => page.screenshot({ path: `${output}/${name}.png`, fullPage: true })
const switchTo = async (tf: string, pane = 0) => { await page.getByLabel(`Chart ${pane + 1} timeframe`, { exact: true }).selectOption(tf); await settle() }
const drag = async (axis: 'time' | 'price' | 'plot', dx: number, dy = 0, pane = 0) => {
  const box = (await page.locator('.chart-canvas').nth(pane).boundingBox())!, state = await read(pane)
  const x = box.x + (axis === 'price' ? state.plotWidth + 25 : state.plotWidth * (axis === 'plot' ? 0.2 : 0.65))
  const y = box.y + (axis === 'time' ? box.height - state.timeHeight / 2 : state.height * 0.45)
  await page.mouse.move(x, y); await page.mouse.down()
  await page.mouse.move(x + dx, y + dy, { steps: 20 }); await page.mouse.up(); await settle()
}
const wheel = async (axis: 'time' | 'price' | 'plot', delta: number, pane = 0) => {
  const box = (await page.locator('.chart-canvas').nth(pane).boundingBox())!, state = await read(pane)
  await page.mouse.move(box.x + (axis === 'price' ? state.plotWidth + 25 : state.plotWidth * 0.65),
    box.y + (axis === 'time' ? box.height - state.timeHeight / 2 : state.height * 0.45))
  await page.mouse.wheel(0, delta); await settle()
}
const close = (a: number, b: number, label = 'range') => assert(Math.abs(a - b) < (label.includes('price') ? 1e-9 : 0.1), `${label}: ${a} != ${b}`)
const visible = (s: Awaited<ReturnType<typeof read>>) => {
  assert(s.visible > 0, 'candles must be visible')
  assert(s.lastX > 0 && s.lastX < s.plotWidth, 'replay candle must stay inside plot')
  assert(s.lastY > 0 && s.lastY < s.height, 'autoscaled replay candle must be visible vertically')
}
const resetFollow = async (pane = 0, width = 100) => {
  await page.evaluate(({ pane, width }) => {
    const { chart, series, sync } = (globalThis as any).__charts[pane]
    series.priceScale().applyOptions({ autoScale: true })
    const data = series.data(), last = chart.timeScale().timeToIndex(data.at(-1).time)
    sync.activate(pane); chart.timeScale().setVisibleLogicalRange({ from: last + 26 - width, to: last + 26 })
  }, { pane, width }); await settle()
}
try {
  await page.goto(origin)
  await page.getByRole('button', { name: 'Resume backtest', exact: true }).click()
  await page.locator('.phase-trading').waitFor(); await settle()
  await shot('h1-before-switch')
  const h1 = await read(); await switchTo('M5'); const m5 = await read(); await shot('m5-after-switch')
  await switchTo('H1'); const back = await read(); await shot('h1-round-trip')
  await drag('time', -180); const axis = await read()
  await drag('price', 0, 100); const manual = await read()
  await switchTo('M15'); const unsavedPrice = await read()
  reports.push({ h1, m5, back, axis, manual, unsavedPrice })
  console.log('Verified initial timeframe and price-scale reproduction')
  assert(Math.abs(h1.span - m5.span) < 1)
  assert(Math.abs(h1.span - back.span) < 1)
  assert(axis.span < back.span, 'native bottom axis must zoom in')
  assert.equal(manual.autoScale, false)
  assert.equal(unsavedPrice.autoScale, true)
  assert(unsavedPrice.visible > 0)
  const sparse = await page.evaluate(async path => (await import(/* @vite-ignore */ path)).sparseViewportFixture(), `/@fs/${resolve('scripts/chart-viewport-fixture.ts')}`)
  console.log('Verified empty history, one candle and market gaps')
  assert.equal(sparse[0].range, null)
  for (const sample of sparse) if (sample.count) assert(sample.lastX > 0 && sample.lastX < sample.width, 'sparse/gap replay edge visible')
  reports.push({ check: 'empty, one candle and weekend gap', sparse })

  // A timeframe's manual scale is saved before its data is replaced. A saved
  // autoscale target and an entirely unsaved target both reset vertical scaling.
  await switchTo('H1'); const restoredManual = await read()
  assert.equal(restoredManual.autoScale, false)
  close(restoredManual.price.from, manual.price.from, 'manual lower price')
  close(restoredManual.price.to, manual.price.to, 'manual upper price')
  await switchTo('M5'); assert.equal((await read()).autoScale, true)
  await wheel('price', -100); const manualM5 = await read()
  assert.equal(manualM5.autoScale, false)
  close(manualM5.span, axis.span, 'vertical wheel leaves horizontal zoom alone')
  await switchTo('M15'); assert.equal((await read()).autoScale, true)
  await switchTo('M5'); const restoredM5 = await read()
  close(restoredM5.price.from, manualM5.price.from, 'saved M5 lower price')
  close(restoredM5.price.to, manualM5.price.to, 'saved M5 upper price')
  reports.push({ check: 'independent vertical preferences', restoredManual, manualM5, restoredM5 })

  for (const count of [1, 2, 3]) {
    await page.locator(`input[name="chart-count"][value="${count}"]`).check(); await settle()
    for (let pane = 0; pane < count; pane++) { await switchTo('H1', pane); await resetFollow(pane, 100) }
    for (let pane = 0; pane < count; pane++) {
      const others = await Promise.all(Array.from({ length: count }, (_, i) => read(i)))
      const start = await read(pane); visible(start)
      await drag('time', -80, 0, pane); const axisIn = await read(pane)
      assert(axisIn.span < start.span); close(axisIn.range.to, start.range.to)
      await drag('time', 80, 0, pane); const axisOut = await read(pane)
      assert(axisOut.span > axisIn.span)
      await wheel('plot', -120, pane); const wheelIn = await read(pane)
      assert(wheelIn.span < axisOut.span); close(wheelIn.range.to, axisOut.range.to)
      await wheel('time', -100, pane); const bottomWheel = await read(pane)
      assert(bottomWheel.span < wheelIn.span, 'wheel also zooms over the bottom axis')
      close(bottomWheel.range.to, wheelIn.range.to)
      await wheel('plot', 100, pane); assert((await read(pane)).span > bottomWheel.span)
      const beforePan = await read(pane)
      await drag('plot', beforePan.plotWidth * 0.6, 0, pane); const historical = await read(pane)
      assert(historical.range.to < beforePan.range.to); close(historical.span, beforePan.span)
      assert.equal(historical.view.following, false)
      // Preserve the historical UTC anchor, rather than an index in another TF.
      const anchor = historical.view.range.to
      for (const tf of ['M5', 'M15', 'H4', 'H1', 'M5', 'H1']) {
        await switchTo(tf, pane); const switched = await read(pane)
        close(switched.span, historical.span, `${count}/${pane}/${tf} span`)
        assert(Math.abs(switched.view.range.to - anchor) < 1, `historical UTC anchor ${count}/${pane}/${tf}: ${anchor} -> ${switched.view.range.to}; ${JSON.stringify(switched)}`)
        assert(switched.visible > 0)
      }
      for (let i = 0; i < count; i++) if (i !== pane) {
        const other = await read(i)
        close(other.range.from, others[i].range.from, 'other pane from'); close(other.range.to, others[i].range.to, 'other pane to')
      }
      // Paused history is stable through a resize and delay beyond activation.
      await page.setViewportSize({ width: 1100, height: 1000 }); await settle()
      close((await read(pane)).range.to, historical.range.to)
      await page.setViewportSize({ width: 1440, height: 1000 }); await settle()
      close((await read(pane)).range.to, historical.range.to)
      await resetFollow(pane)
      for (const tf of ['M5', 'H4', 'D1', 'H1']) {
        const beforeSwitch = await read(pane)
        await switchTo(tf, pane); const switched = await read(pane)
        close(switched.span, beforeSwitch.span, 'follow span'); visible(switched)
      }
      // Repeated gestures reach minimum width while retaining candle bodies,
      // even though the Ichimoku projection is longer than the viewport.
      for (let i = 0; i < 5; i++) await wheel('plot', -500, pane)
      const narrowWheel = await read(pane); visible(narrowWheel); close(narrowWheel.span, 5)
      await drag('time', -80, 0, pane); const narrowAxis = await read(pane); visible(narrowAxis); close(narrowAxis.span, 5)
      await drag('plot', -narrowAxis.plotWidth * 0.6, 0, pane); const future = await read(pane); visible(future)
      assert(future.range.to - future.last <= future.span - 2 + 0.1)
      await shot(`layout-${count}-pane-${pane + 1}-narrow`)
      reports.push({ check: 'layout gestures and switches', count, pane, start, axisIn, wheelIn, bottomWheel, historical, narrowWheel, narrowAxis, future })
      await resetFollow(pane)
    }
    await shot(`layout-${count}`)
  }
  // A forward observation recovers an offscreen manual chart; paused inspection
  // and keyboard historical review do not advance execution or force following.
  await page.locator('input[name="chart-count"][value="1"]').check(); await switchTo('M5'); await resetFollow()
  await drag('plot', 700); const paused = await read()
  assert.equal(paused.view.following, false)
  await page.waitForTimeout(1600); close((await read()).range.to, paused.range.to)
  const progress = () => page.locator('[aria-label="Replay progress"]').textContent()
  const executionBefore = await progress()
  await page.locator('.chart-canvas').click({ position: { x: 100, y: 100 } })
  await page.keyboard.press('Control+Shift+ArrowLeft'); await settle()
  await page.locator('.history-review').waitFor()
  close((await read()).range.to, paused.range.to)
  await page.keyboard.press('Control+Shift+ArrowRight'); await settle()
  assert.equal(await progress(), executionBefore)
  await page.getByRole('button', { name: 'Next Min', exact: true }).click(); await settle()
  const advanced = await read(); visible(advanced); assert.equal(advanced.view.following, true)
  await page.getByLabel('Replay speed', { exact: true }).selectOption('100')
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await page.waitForFunction(before => document.querySelector('[aria-label="Replay progress"]')?.textContent !== before, executionBefore)
  await switchTo('H1'); await page.getByRole('button', { name: 'Pause', exact: true }).click(); await settle()
  visible(await read())
  reports.push({ check: 'paused history and forward replay', paused, advanced, executionBefore, executionAfter: await progress() })

  // Persist different zoom, navigation, timeframes, indicators and price ranges
  // in three panes, then reload and resume the actual disk-backed session.
  await page.locator('input[name="chart-count"][value="3"]').check(); await settle()
  for (let pane = 0; pane < 3; pane++) {
    await switchTo(['H1', 'M15', 'M5'][pane], pane); await resetFollow(pane, 80 + pane * 35)
    await drag('plot', 120 + pane * 30, 0, pane); await wheel('price', 50 + pane * 20, pane)
  }
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: 'Sessions / settings', exact: true }).click()
  await page.getByRole('button', { name: 'Save now', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.save-state')?.textContent === 'Saved')
  const beforeReload = await Promise.all([read(0), read(1), read(2)])
  const saved = (await storage.list()).sessions[0]
  await page.reload(); await page.getByRole('button', { name: 'Resume backtest', exact: true }).click()
  await page.locator('.phase-trading').waitFor(); await settle()
  assert.equal(await page.locator('.chart-pane').count(), 3)
  const afterReload = await Promise.all([read(0), read(1), read(2)])
  for (let pane = 0; pane < 3; pane++) {
    close(afterReload[pane].range.from, beforeReload[pane].range.from, 'restored from')
    close(afterReload[pane].range.to, beforeReload[pane].range.to, 'restored to')
    assert.equal(afterReload[pane].autoScale, false)
    close(afterReload[pane].price.from, beforeReload[pane].price.from, 'restored price from')
    close(afterReload[pane].price.to, beforeReload[pane].price.to, 'restored price to')
    assert(afterReload[pane].visible > 0)
    assert.equal(await page.getByLabel(`Chart ${pane + 1} timeframe`, { exact: true }).inputValue(), ['H1', 'M15', 'M5'][pane])
  }
  assert.deepEqual((await storage.list()).sessions[0].checkpoint.trading, saved.checkpoint.trading)
  await shot('restored-preferences')
  reports.push({ check: 'session reload', beforeReload, afterReload })
  assert.deepEqual(errors, []); assert.deepEqual(external, [])
  await writeFile(`${output}/browser-evidence.json`, JSON.stringify({ reports, errors, external }, null, 2) + '\n')
  console.log(`Verified ${reports.length} scenario groups with real Chromium gestures; no page errors or external requests`)
} catch (error) {
  await shot('failure'); throw error
} finally {
  await browser.close(); await vite.close()
  await new Promise<void>(done => { api.close(() => done()); api.closeAllConnections() })
  await storage.close(); await rm(directory, { recursive: true, force: true })
}
