// Native separator drags against the production App. Uses disposable history,
// sessions and a persistent Chromium profile; never touches the user's archive.
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
import { indicatorPreset } from '../frontend/src/indicators.js'
import { benchmarkHistory } from './chart-replay-data.js'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core')
const output = process.env.BROWSER_OUTPUT ?? 'docs/stochastic-pane-height'
await mkdir(output, { recursive: true })
const directory = await mkdtemp(join(tmpdir(), 'forextester-pane-height-'))
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
snapshot.checkpoint.workspace = selectChartMode(defaultWorkspace(), 3)
for (const mode of Object.values(snapshot.checkpoint.workspace.chartModes!)) {
  mode!.timeframes = ['M5', 'M5', 'M5']
  mode!.indicators = [0, 1, 2].map(() => ({ M5: indicatorPreset('M5') }))
}
snapshot.checkpoint.workspace.timeframes = ['M5', 'M5', 'M5']
snapshot.checkpoint.workspace.indicators = [0, 1, 2].map(() => ({ M5: indicatorPreset('M5') }))
const ids = [randomUUID(), randomUUID()]
try {
  globalThis.fetch = ((path: string, init?: RequestInit) => nativeFetch(`${apiOrigin}${path}`, { ...init, headers: { Origin: apiOrigin, ...init?.headers } })) as typeof fetch
  const store = new DiskSessionStore(), historyId = await historyFingerprint(history)
  await store.cacheHistory(historyId, history)
  for (const [index, id] of ids.entries()) await store.save({ id, name: `Pane ${index === 0 ? 'A' : 'B'}`, createdAt: new Date().toISOString(), range: { from: history.tradingFrom, to: history.to }, totalCandles: history.bid.length, historyId }, snapshot, null)
} finally { globalThis.fetch = nativeFetch }

const vite = await createServer({ configFile: false, root: resolve('frontend'), cacheDir: join(directory, 'vite'),
  plugins: [{ name: 'test-only-chart-probe', transform(code, path) {
    if (!path.endsWith('/src/ChartPane.tsx')) return
    // Observe public chart APIs without adding any hooks to the shipped app.
    return code.replace('chartRef.current = chart', '(globalThis.__charts ??= {})[id] = { chart }; chartRef.current = chart')
  } }], server: { host: '127.0.0.1', port: 0, hmr: false, proxy: { '/api': { target: apiOrigin } } } })
await vite.listen()
const origin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`
const launch = () => chromium.launchPersistentContext(join(directory, 'chromium-profile'), {
  executablePath: process.env.CHROMIUM_PATH ?? '/home/admin/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome',
  headless: true, args: ['--no-sandbox'], viewport: { width: 1440, height: 1000 },
})
let context = await launch(), page = await context.newPage()
const errors: string[] = [], external: string[] = [], reports: unknown[] = []
const instrument = async () => {
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => {
    if (!route.request().url().startsWith(origin)) { external.push(route.request().url()); return route.abort() }
    if (/\/api\/history\//.test(route.request().url())) return route.fulfill({ json: { datasets: [], days: [] } })
    return route.continue()
  })
}
const settle = () => page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => done())))))
const read = (slot = 0) => page.evaluate(slot => {
  const { chart } = (globalThis as any).__charts[slot], panes = chart.panes()
  const factors = panes.map((p: any) => p.getStretchFactor()), heights = panes.map((p: any) => p.getHeight())
  return { factors, heights, share: factors[1] / (factors[0] + factors[1]), actual: heights[1] / (heights[0] + heights[1]) }
}, slot)
const saved = (session = 0, slot = 0) => page.evaluate(({ id, slot }) => JSON.parse(localStorage.getItem(`forextester:ui:v1:${id}`) ?? '{}')[`stochasticPane:${slot}`], { id: ids[session], slot })
const close = (a: number, b: number) => assert(Math.abs(a - b) < 0.004, `pane shares ${a} and ${b} differ`)
const selectCount = async (count: number) => {
  await page.locator(`input[name="chart-count"][value="${count}"]`).check(); await settle()
  assert.equal(await page.locator('.chart-pane').count(), count)
}
const resume = async (name: string) => {
  await page.locator('.saved-session').filter({ has: page.getByRole('button', { name: `Rename backtest Pane ${name}`, exact: true }) }).getByRole('button', { name: /Resume (backtest|session)/ }).click()
  await page.waitForFunction(name => document.querySelector('.session-name')?.textContent === `Pane ${name}`, name)
  await page.locator('.phase-trading').waitFor(); await settle()
}
const switchSession = async (name: string) => {
  await page.getByRole('button', { name: 'Sessions / settings', exact: true }).click()
  await page.getByRole('button', { name: 'Resume / Manage sessions', exact: true }).click()
  await resume(name)
  const toggle = page.getByRole('button', { name: 'Sessions / settings', exact: true })
  if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click()
  await settle()
}
const drag = async (slot: number, dy: number, session = 0) => {
  const before = await read(slot), previousSaved = await saved(session, slot)
  const box = await page.evaluate(slot => {
    const { chart } = (globalThis as any).__charts[slot]
    const row = chart.panes()[0].getHTMLElement().getBoundingClientRect()
    return { x: row.x + row.width * .5, y: row.bottom + .5 }
  }, slot)
  await page.mouse.move(box.x, box.y); await page.mouse.down()
  await page.mouse.move(box.x, box.y + dy, { steps: 15 }); await settle()
  const moving = await read(slot)
  assert(Math.abs(moving.share - before.share) > .01, 'native separator must move')
  assert.equal(await saved(session, slot), previousSaved, 'must not write while dragging')
  await page.mouse.up(); await settle()
  const after = await read(slot)
  assert(after.heights.every((h: number) => h >= 29), 'native minimum pane heights')
  return after
}
try {
  await instrument(); await page.goto(origin); await resume('A')
  for (const slot of [0, 1, 2]) {
    close((await read(slot)).share, .25)
    assert.equal(await saved(0, slot), undefined, 'initialization must not save defaults')
  }
  await page.screenshot({ path: `${output}/default-three.png`, fullPage: true })
  const expected: number[] = []
  for (const [slot, dy] of [[0, -110], [1, -65], [2, 30]]) {
    const state = await drag(slot, dy); expected[slot] = state.share
    close(await saved(0, slot), state.share)
    reports.push({ check: `native-drag-slot-${slot}`, state })
  }
  await page.screenshot({ path: `${output}/resized-three.png`, fullPage: true })
  for (const count of [1, 2, 3]) {
    await selectCount(count)
    for (let slot = 0; slot < count; slot++) close((await read(slot)).share, expected[slot])
    for (let slot = 0; slot < count; slot++) {
      const state = await drag(slot, slot % 2 ? -16 : 16)
      expected[slot] = state.share
      close(await saved(0, slot), state.share)
      for (let other = 0; other < count; other++) close((await read(other)).share, expected[other])
      reports.push({ check: `native-drag-layout-${count}-slot-${slot}`, state })
    }
    await page.screenshot({ path: `${output}/layout-${count}.png`, fullPage: true })
  }
  reports.push({ check: 'independent-slots-across-all-layouts', expected })
  await page.getByLabel('Chart 1 timeframe', { exact: true }).selectOption('H1'); await settle()
  assert.equal((await read()).factors.length, 1); close(await saved(), expected[0])
  await page.getByLabel('Chart 1 timeframe', { exact: true }).selectOption('M5'); await settle()
  close((await read()).share, expected[0])
  await page.locator('.chart-pane').first().locator('.indicator-controls summary').click()
  await page.getByLabel('Chart 1 Stochastic', { exact: true }).uncheck(); await settle()
  assert.equal((await read()).factors.length, 1); close(await saved(), expected[0])
  await page.getByLabel('Chart 1 Stochastic', { exact: true }).check(); await settle()
  close((await read()).share, expected[0]); await page.keyboard.press('Escape')
  reports.push({ check: 'timeframe-and-disable-reenable', state: await read() })
  for (const viewport of [{ width: 1100, height: 720 }, { width: 1600, height: 1100 }, { width: 1440, height: 1000 }]) {
    await page.setViewportSize(viewport); await settle()
    for (const slot of [0, 1, 2]) { const state = await read(slot); close(state.share, expected[slot]); close(state.actual, expected[slot]) }
    reports.push({ check: 'browser-resize', viewport })
  }
  // A very small container clamps the display, then recovers the intended ratio.
  await page.locator('.chart-canvas').first().evaluate(el => { (el as HTMLElement).style.height = '100px' }); await settle()
  const small = await read(); assert(small.heights.every((h: number) => h >= 29)); close(await saved(), expected[0])
  await page.locator('.chart-canvas').first().evaluate(el => { (el as HTMLElement).style.height = '' }); await settle()
  close((await read()).share, expected[0]); reports.push({ check: 'container-minimum-and-recovery', small })
  await page.getByRole('button', { name: 'Next Min', exact: true }).click(); await settle()
  close((await read()).share, expected[0]); close(await saved(), expected[0])
  await switchSession('B')
  for (const slot of [0, 1, 2]) { close((await read(slot)).share, .25); assert.equal(await saved(1, slot), undefined) }
  const second = await drag(0, -40, 1); close(await saved(1), second.share)
  await switchSession('A')
  for (const slot of [0, 1, 2]) close((await read(slot)).share, expected[slot])
  reports.push({ check: 'switch-backtests-without-leaking', second })
  await page.reload(); await resume('A')
  for (const slot of [0, 1, 2]) close((await read(slot)).share, expected[slot])
  reports.push({ check: 'reload', state: await read() })
  await context.close(); context = await launch(); page = await context.newPage(); await instrument()
  await page.goto(origin); await resume('A')
  for (const slot of [0, 1, 2]) close((await read(slot)).share, expected[slot])
  await page.screenshot({ path: `${output}/browser-reopened.png`, fullPage: true })
  reports.push({ check: 'full-browser-close-and-reopen', state: await read() })
  assert.deepEqual(errors, []); assert.deepEqual(external, [])
  await writeFile(`${output}/verification.json`, JSON.stringify({ reports, errors, external }, null, 2) + '\n')
  console.log(JSON.stringify({ checks: reports, errors, external }, null, 2))
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png`, fullPage: true }).catch(() => {})
  console.error(await page.locator('body').innerText().catch(() => '')); throw error
} finally {
  await context.close(); await vite.close()
  await new Promise<void>(done => { api.close(() => done()); api.closeAllConnections() })
  await storage.close(); await rm(directory, { recursive: true, force: true })
}
