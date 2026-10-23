import { chromium } from 'playwright-core'
import { createServer } from 'vite'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { SessionStore } from '../frontend/src/sessionStore.ts'
import { historyFingerprint } from '../frontend/src/sessionCodec.ts'
import { sessionHistory, sessionSimulation, manualPermission } from '../frontend/src/sessionFixtures.ts'
import { requestEntry } from '../frontend/src/trading.ts'
import { DiskSessionStore } from '../frontend/src/diskSessionStore.ts'

const directory = await mkdtemp(join(tmpdir(), 'forextester-browser-'))
const vite = await createServer({ configFile: false, root: join(process.cwd(), 'frontend'), server: { host: '127.0.0.1', port: 5187, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:3017', changeOrigin: false } } } })
let child: ReturnType<typeof spawn>
async function startBackend() {
  child = spawn(process.execPath, ['--import', 'tsx', 'scripts/durable-storage-browser-server.mts'], { cwd: process.cwd(), env: { ...process.env, FOREXTESTER_DATA_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise<void>((resolve, reject) => { child.stdout!.once('data', () => resolve()); child.once('exit', (code) => reject(new Error(`Backend exited ${code}`))); child.stderr!.on('data', (d) => process.stderr.write(d)) })
}
async function stopBackend() { if (child && child.exitCode === null) { const stopped = new Promise<void>((r) => child.once('exit', () => r())); child.kill('SIGKILL'); await stopped } }
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? '/home/admin/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell' })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const errors: string[] = [], results: Record<string, unknown> = {}
const origin = 'http://127.0.0.1:5187'
let page = await context.newPage()
const watch = () => { page.on('pageerror', (e) => errors.push(e.message)); page.on('dialog', (dialog) => dialog.accept()) }
async function saved() { await page.getByRole('button', { name: 'Save now', exact: true }).click(); await page.locator('.session-status strong').filter({ hasText: /^Saved$/ }).waitFor({ timeout: 10000 }).catch(async (e) => { throw new Error(`${e.message}; UI=${await page.locator('.session-controls').textContent()}; pageErrors=${errors.join(',')}`) }) }
async function current() { const name = await page.getByLabel('Current session name').inputValue(); return page.evaluate(async (name) => { const body = await (await fetch('/api/storage/sessions')).json(); return body.sessions.find((record) => record.name === name) }, name) }
async function resume(name: string) { await page.locator('.saved-session').filter({ hasText: name }).getByRole('button', { name: 'Resume session', exact: true }).click(); await page.locator('.workspace-controls').waitFor({ state: 'visible' }); await page.waitForFunction((name) => { const input = document.querySelector<HTMLInputElement>('[aria-label="Current session name"]'), fields = document.querySelector<HTMLFieldSetElement>('.workspace-controls'); return input?.value === name && fields && !fields.disabled && !fields.hidden }, name) }
try {
  await startBackend(); await vite.listen(); watch()
  await page.goto(origin)
  await page.getByRole('button', { name: 'Start Replay', exact: true }).waitFor()
  await page.getByLabel('Current session name').fill('Browser durable verification')
  await page.getByLabel('Reference balance (USD)', { exact: true }).fill('10000')
  await page.getByLabel('Maximum combined gross planned risk (%)', { exact: true }).fill('20')
  await page.getByLabel('Round-trip commission (USD per standard lot)', { exact: true }).fill('7')
  await page.getByRole('button', { name: 'Start Replay', exact: true }).click()
  await page.getByLabel('Sizing mode', { exact: true }).selectOption('manual')
  await page.getByLabel('Volume (lots)', { exact: true }).fill('0.1')
  await page.getByLabel('SL price', { exact: true }).fill('1.098')
  await page.getByRole('button', { name: 'Buy', exact: true }).click()
  await page.getByLabel('Volume (lots)', { exact: true }).fill('0.2')
  await page.getByRole('button', { name: 'Buy', exact: true }).click()
  await page.getByRole('button', { name: 'Next Candle', exact: true }).click()
  const stops = page.locator('input[aria-label^="Replacement SL "]')
  for (let i = 0; i < 2; i++) { await stops.nth(i).fill(i ? '1.099' : '1.0988'); await page.locator('button[aria-label^="Update SL "]').nth(i).click() }
  await page.locator('button[aria-label^="Details for setup "]').first().click()
  await page.locator('textarea[aria-label^="Setup notes "]').fill('Durable browser notes')
  await page.getByRole('button', { name: 'Next Candle', exact: true }).click()
  await page.locator('input[name="chart-count"][value="2"]').check()
  await page.getByLabel('Chart 1 timeframe', { exact: true }).selectOption('M15')
  await page.getByLabel('Journal view', { exact: true }).selectOption('positions')
  await page.getByLabel('Volume (lots)', { exact: true }).fill('0.33')
  await page.locator('.additional-statistics summary').click()
  await saved()
  const baseline = await current()
  assert.equal(baseline.checkpoint.trading.positions.length, 2)
  assert.ok(Math.abs(baseline.checkpoint.trading.positions[0].entryCommissionUsd - .35) < 1e-10)
  assert.equal(baseline.checkpoint.trading.setups[0].notes, 'Durable browser notes')
  await page.screenshot({ path: '/tmp/task17-desktop.png', fullPage: true })
  await page.close(); await stopBackend(); await startBackend()
  page = await context.newPage(); watch(); await page.goto(origin); await resume('Browser durable verification')
  assert.equal(await page.locator('[aria-label="Replay status"]').textContent(), 'Paused')
  assert.equal(await page.locator('.chart-pane').count(), 2)
  assert.equal(await page.getByLabel('Chart 1 timeframe', { exact: true }).inputValue(), 'M15')
  assert.equal(await page.getByLabel('Journal view', { exact: true }).inputValue(), 'positions')
  assert.equal(await page.getByLabel('Volume (lots)', { exact: true }).inputValue(), '0.33')
  assert.equal(await page.locator('.additional-statistics').getAttribute('open'), '')
  const restored = await current(); assert.deepEqual(restored.checkpoint.trading, baseline.checkpoint.trading); assert.deepEqual(restored.checkpoint.equity, baseline.checkpoint.equity)
  results.scenarioA = 'Two positions, SL changes, notes, fees, equity and replay restored paused after SIGKILL/backend restart'
  results.scenarioCRefresh = 'Layout, M15, journal scope, expanded statistics and unsubmitted order draft restored'
  await page.evaluate(async () => { localStorage.clear(); await new Promise<void>((resolve, reject) => { const r = indexedDB.deleteDatabase('forextester-sessions'); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); r.onblocked = () => reject(new Error('blocked')) }) })
  await page.reload(); await resume('Browser durable verification')
  const cleared = await current(); assert.deepEqual(cleared.checkpoint.trading, baseline.checkpoint.trading); assert.deepEqual(cleared.checkpoint.equity, baseline.checkpoint.equity)
  assert.equal(await page.locator('.chart-pane').count(), 1)
  results.scenarioB = 'IndexedDB and localStorage cleared; disk session and exact financial results retained'
  const otherContext = await browser.newContext(), other = await otherContext.newPage()
  await other.goto(origin); await other.locator('.saved-session').filter({ hasText: 'Browser durable verification' }).getByRole('button', { name: 'Resume session', exact: true }).click()
  await other.locator('.workspace-controls').waitFor({ state: 'visible' }); assert.equal(await other.locator('.chart-pane').count(), 1)
  assert.equal((await other.evaluate(async () => (await (await fetch('/api/storage/sessions')).json()).sessions[0])).id, baseline.id)
  await otherContext.close(); results.differentProfile = 'Independent browser context sees the same disk records with default UI'
  // Seed a genuine schema-v1 IndexedDB checkpoint with the legacy adapter.
  Object.assign(globalThis, { IDBKeyRange })
  const old = new SessionStore(new IDBFactory()), sim = sessionSimulation(sessionHistory(120)); sim.observe()
  sim.state = requestEntry(sim.state, 'buy', .1, 1.098, manualPermission); sim.observe(2)
  const oldBase = { id: crypto.randomUUID(), name: 'PR14 migration verification', createdAt: new Date().toISOString(), historyId: await historyFingerprint(sim.history), totalCandles: sim.history.bid.length, range: { from: sim.history.tradingFrom, to: sim.history.to } }
  await old.cacheHistory(oldBase.historyId, sim.history); const legacy = await old.save(oldBase, sim.snapshot(), null)
  await old.close()
  await page.evaluate(async ({ legacy, history, points }) => {
    await new Promise<void>((resolve, reject) => {
      const op = indexedDB.open('forextester-sessions', 1)
      op.onupgradeneeded = () => { const db = op.result; db.createObjectStore('sessions', { keyPath: 'id' }); db.createObjectStore('equity', { keyPath: ['sessionId', 'index'] }); db.createObjectStore('history', { keyPath: 'id' }) }
      op.onerror = () => reject(op.error)
      op.onsuccess = () => { const db = op.result, tx = db.transaction(['sessions', 'equity', 'history'], 'readwrite'); tx.objectStore('sessions').put(legacy); tx.objectStore('history').put({ id: legacy.historyId, history }); tx.objectStore('equity').put({ sessionId: legacy.id, index: 0, hash: legacy.chunkHashes[0], points }); tx.oncomplete = () => { db.close(); resolve() }; tx.onabort = () => reject(tx.error) }
    })
  }, { legacy, history: sim.history, points: (await import('../frontend/src/sessionCodec.ts')).equitySuffix(sim.ledger, 0) })
  await page.reload(); await page.getByRole('button', { name: 'Import to disk', exact: true }).click()
  await page.getByRole('button', { name: 'Import to disk', exact: true }).waitFor({ state: 'hidden' })
  await resume('PR14 migration verification')
  const migrated = await current(); assert.deepEqual(migrated.checkpoint.trading, legacy.checkpoint.trading); assert.deepEqual(migrated.checkpoint.equity, legacy.checkpoint.equity)
  await page.getByRole('button', { name: 'Next Candle', exact: true }).click(); await saved()
  const advanced = await current(); assert.equal(advanced.checkpoint.trading.positions[0].entryCommissionUsd, legacy.checkpoint.trading.positions[0].entryCommissionUsd)
  assert.equal(await page.evaluate(async () => new Promise<number>((resolve) => { const op = indexedDB.open('forextester-sessions'); op.onsuccess = () => { const db = op.result, tx = db.transaction('sessions'), r = tx.objectStore('sessions').count(); r.onsuccess = () => resolve(r.result); tx.oncomplete = () => db.close() } })), 1)
  results.scenarioD = 'PR14 schema imported with identical trading/equity, legacy original retained; next step does not duplicate entry commission'
  await page.locator('input[name="chart-count"][value="3"]').check(); await saved()
  await page.getByRole('button', { name: 'Resume / Manage sessions', exact: true }).click(); await resume('Browser durable verification')
  assert.equal(await page.locator('.chart-pane').count(), 1)
  results.scenarioCIsolation = 'Three-chart migration workspace remains isolated from original one-chart session'
  await stopBackend(); await page.getByRole('button', { name: 'Save now', exact: true }).click(); await page.locator('.session-controls [role="alert"]').waitFor()
  await startBackend(); await saved(); results.backendUnavailable = 'Visible error, memory preserved, Save now retries successfully'
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: '/tmp/task17-mobile.png', fullPage: true })
  results.mobile = { width: 390, documentWidth: await page.evaluate(() => document.documentElement.scrollWidth), viewport: await page.evaluate(() => window.innerWidth) }
  const nativeFetch = globalThis.fetch
  globalThis.fetch = ((path: string, init?: RequestInit) => nativeFetch(`http://127.0.0.1:3017${path}`, { ...init, headers: { Origin: 'http://127.0.0.1:3017', ...init?.headers } })) as typeof fetch
  try {
    const diskClient = new DiskSessionStore(), large = sessionSimulation(sessionHistory(129600)); large.observe(100)
    const base = { id: crypto.randomUUID(), name: '90-day playback measurement', createdAt: new Date().toISOString(), range: { from: large.history.tradingFrom, to: large.history.to }, totalCandles: large.history.bid.length, historyId: await historyFingerprint(large.history) }
    await diskClient.cacheHistory(base.historyId, large.history); await diskClient.save(base, large.snapshot(), null)
  } finally { globalThis.fetch = nativeFetch }
  const performanceContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), perf = await performanceContext.newPage()
  perf.on('pageerror', (e) => errors.push(e.message))
  await perf.goto(origin)
  const hydrationStart = performance.now()
  await perf.locator('.saved-session').filter({ hasText: '90-day playback measurement' }).getByRole('button', { name: 'Resume session', exact: true }).click()
  await perf.waitForFunction(() => { const f = document.querySelector<HTMLFieldSetElement>('.workspace-controls'); return f && !f.disabled && !f.hidden })
  const browserRestoreMs = performance.now() - hydrationStart
  await perf.locator('input[name="chart-count"][value="3"]').check()
  await perf.getByLabel('Replay speed', { exact: true }).selectOption('100')
  let playingAt = 0
  const starts = new Map<object, number>(), checkpoints: { startAfterPlayMs: number; elapsedMs: number; bytes: number }[] = []
  perf.on('request', (request) => { if (request.url().endsWith('/checkpoint') && playingAt) starts.set(request, performance.now()) })
  perf.on('response', async (response) => { const start = starts.get(response.request()); if (start) { await response.finished(); checkpoints.push({ startAfterPlayMs: start - playingAt, elapsedMs: performance.now() - start, bytes: response.request().postDataBuffer()?.length ?? 0 }) } })
  playingAt = performance.now()
  await perf.getByRole('button', { name: 'Play', exact: true }).click()
  await perf.waitForTimeout(6500)
  await perf.getByRole('button', { name: 'Pause', exact: true }).click()
  await perf.getByRole('button', { name: 'Save now', exact: true }).click()
  await perf.locator('.session-status strong').filter({ hasText: /^Saved$/ }).waitFor()
  const performanceRecord = await perf.evaluate(async () => (await (await fetch('/api/storage/sessions')).json()).sessions.find((r) => r.name === '90-day playback measurement'))
  results.playback100x = { browserRestoreMs, elapsedMs: performance.now() - playingAt, observationsAdvanced: performanceRecord.checkpoint.executionCursor - 101, equityCount: performanceRecord.checkpoint.equity.count, checkpoints }
  assert.ok(checkpoints.some((sample) => sample.startAfterPlayMs >= 4000))
  await performanceContext.close()
  results.browserErrors = errors
  assert.deepEqual(errors, [])
  await writeFile('/tmp/task17-browser-results.json', JSON.stringify(results, null, 2)); console.log(JSON.stringify(results, null, 2))
} finally { await browser.close(); await vite.close(); await stopBackend(); await rm(directory, { recursive: true, force: true }) }
