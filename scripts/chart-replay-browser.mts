import { verifyReplayWorkspace } from './chart-replay-verification'
// Requires the existing verification-only playwright-core and a Chromium installation.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core')
import { createServer } from 'vite'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { benchmarkHistory } from './chart-replay-data'
import { DiskSessionStore } from '../frontend/src/diskSessionStore'
import { historyFingerprint } from '../frontend/src/sessionCodec'
import { sessionSimulation } from '../frontend/src/sessionFixtures'
import { indicatorPreset } from '../frontend/src/indicators'
import { createTradingState } from '../frontend/src/trading'
const label = process.argv[2] ?? 'after'
const benchmarkRoot = process.env.BENCHMARK_ROOT ?? process.cwd()
const appRoot = process.env.APP_ROOT ?? process.cwd()
const directory = await mkdtemp(join(tmpdir(), 'forextester-browser-'))
const vite = await createServer({ configFile: false, root: join(appRoot, 'frontend'), server: { host: '127.0.0.1', port: 5187, strictPort: true, fs: { allow: [process.cwd(), benchmarkRoot, appRoot] }, proxy: { '/api': { target: 'http://127.0.0.1:3017', changeOrigin: false } } }, plugins: [{ name: 'chart-benchmark-page', configureServer(server) { server.middlewares.use('/task19-benchmark.html', (_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><head><link rel="stylesheet" href="/src/style.css"></head><body></body></html>') }) } }] })
const child = spawn(process.execPath, ['--import', 'tsx', 'backend/src/server.ts'], { env: { ...process.env, FOREXTESTER_DATA_DIR: directory, PORT: '3017' }, stdio: ['ignore', 'pipe', 'pipe'] })
await new Promise<void>((resolve, reject) => { child.stdout!.once('data', () => resolve()); child.once('exit', (code) => reject(Error(`Backend exited ${code}`))); child.stderr!.on('data', d => process.stderr.write(d)) })
await vite.listen()
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? '/home/admin/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell', args: ['--enable-precise-memory-info'] })
const errors: string[] = [], results: any = { label, direct: [], app: [] }
const origin = 'http://127.0.0.1:5187', api = 'http://127.0.0.1:3017', nativeFetch = globalThis.fetch
try {
  const direct = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  direct.on('pageerror', e => errors.push(e.message))
  await direct.goto(origin + '/task19-benchmark.html')
  if (!process.env.APP_ONLY) for (const days of [2, 90]) for (const [scenario, timeframes, batch, late] of [
    ['A', ['M1'], 1, false], ['B', ['M5', 'H1'], 10, false], ['C', ['M5', 'M15', 'H4'], 100, false], ['D', ['M5', 'M15', 'H4'], 100, true], ['E', ['D1', 'H1', 'M5'], 100, true],
  ] as const) {
    if (process.env.SCENARIO && process.env.SCENARIO !== scenario || process.env.DAYS && Number(process.env.DAYS) !== days) continue
    // Keep the real browser pointer inside the first price pane as it mounts.
    // Hover is part of the workload: it exposes synchronous library hit-testing.
    await direct.mouse.move(200, 60)
    // Absolute /@fs import keeps the harness out of the production application.
    const sample = await direct.evaluate(async ({ path, days, timeframes, batch, late }) => {
      const fixture = await import(/* @vite-ignore */ path)
      return fixture.benchmarkCharts(days, timeframes, batch, late)
    }, { path: `/@fs${benchmarkRoot}/scripts/chart-replay-fixture.ts`, days, timeframes, batch, late })
    results.direct.push({ scenario, ...sample }); await writeFile(`/tmp/task19-${label}.json`, JSON.stringify(results, null, 2)); console.log(JSON.stringify({ phase: 'direct', days, scenario, mean: sample.work.reduce((a: number, b: number) => a+b)/sample.work.length }))
  }
  await direct.close()
  if (!process.env.DIRECT_ONLY) {
  globalThis.fetch = ((path: string, init?: RequestInit) => nativeFetch(`${api}${path}`, { ...init, headers: { Origin: api, ...init?.headers } })) as typeof fetch
  for (const days of [2, 90]) for (const late of [false, true]) {
    const history = benchmarkHistory(days), store = new DiskSessionStore(), sim = sessionSimulation(history)
    sim.state = createTradingState(7, undefined, { roundTripUsdPerLot: 7 })
    const tradingStart = history.bid.findIndex(b => b.timestamp >= Date.parse(history.tradingFrom))
    sim.observe(late ? Math.max(tradingStart, history.bid.length - 10000) : tradingStart)
    const snapshot = sim.snapshot(false, 100)
    // Pre-roll has no financial observations. Seed the reference using the real engine for trading only below.
    snapshot.checkpoint.workspace.viewport = null
    snapshot.checkpoint.workspace.timeframes = ['M5', 'M15', 'H4']
    snapshot.checkpoint.workspace.indicators = ['M5', 'M15', 'H4'].map(tf => ({ [tf]: indicatorPreset(tf as any) }))
    const base = { id: crypto.randomUUID(), name: `Task19-${days}${late ? "-late" : ""}`, createdAt: new Date().toISOString(), range: { from: history.tradingFrom, to: history.to }, totalCandles: history.bid.length, historyId: await historyFingerprint(history) }
    // Build the causal trading state at the real start, with exactly one observation.
    const { observeCandle } = await import('../frontend/src/trading')
    const { createEquityLedger, recordEquity } = await import('../frontend/src/equity')
    const start = snapshot.checkpoint.replay.index!, initial = createTradingState(7, undefined, { roundTripUsdPerLot: 7 })
    let state = initial, ledger = createEquityLedger(initial.account.referenceBalance)
    for (let index = tradingStart; index <= start; index++) {
      const previous = state; state = observeCandle(state, history.bid[index], history.ask[index]); ledger = recordEquity(ledger, previous, state)
    }
    snapshot.checkpoint.trading = state; snapshot.ledger = ledger
    snapshot.checkpoint.equity = (await import('../frontend/src/sessionTypes')).equitySummary(ledger)
    snapshot.checkpoint.replay.startIndex = tradingStart; snapshot.checkpoint.replay.startTimestamp = history.bid[tradingStart].timestamp
    await store.cacheHistory(base.historyId, history); await store.save(base, snapshot, null)
  }
  globalThis.fetch = nativeFetch
  for (const days of [2, 90]) for (const [scenario, frames, speed] of [['A', ['M1'], '1'], ['B', ['M5', 'H1'], '10'], ['C', ['M5', 'M15', 'H4'], '100'], ['D', ['M5', 'M15', 'H4'], '100'], ['H', ['M5', 'M15', 'H4'], '100']] as const) {
    if (scenario === 'H' && days !== 90 || process.env.DAYS && Number(process.env.DAYS) !== days || process.env.SCENARIO && process.env.SCENARIO !== scenario) continue
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    await context.addInitScript('globalThis.__name = (target) => target')
    await context.addInitScript(() => { globalThis.__forexReplayPerformance = { samples: {}, counts: {} } })
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message))
    await page.goto(origin)
    await page.locator('.saved-session').filter({ has: page.locator('.saved-session-info strong').filter({ hasText: new RegExp(`^Task19-${days}${scenario === 'D' || scenario === 'H' ? '-late' : ''}$`) }) }).getByRole('button', { name: 'Resume session', exact: true }).click()
    await page.waitForFunction(() => { const f = document.querySelector<HTMLFieldSetElement>('.workspace-controls'); return f && !f.disabled && !f.hidden })
    await page.locator(`input[name="chart-count"][value="${frames.length}"]`).check()
    for (let i = 0; i < frames.length; i++) await page.getByLabel(`Chart ${i + 1} timeframe`, { exact: true }).selectOption(frames[i])
    await page.getByLabel('Replay speed', { exact: true }).selectOption(speed)
    await page.waitForTimeout(400)
    const before = await page.locator('[aria-label="Replay progress"]').textContent()
    let playingAt = 0, capturingCheckpoints = true
    const checkpoints: { startMs: number; elapsedMs?: number; bytes: number; cursor: number; equityCount: number; playing: boolean }[] = []
    const requests = new Map<object, typeof checkpoints[number]>()
    page.on('request', request => {
      if (!capturingCheckpoints || !playingAt || !request.url().endsWith('/checkpoint')) return
      const body = request.postDataJSON(), checkpoint = body?.record?.checkpoint
      if (!checkpoint) return
      const sample = { startMs: performance.now() - playingAt, bytes: request.postDataBuffer()?.length ?? 0,
        cursor: checkpoint.executionCursor, equityCount: checkpoint.equity.count, playing: checkpoint.replay.playing }
      checkpoints.push(sample); requests.set(request, sample)
    })
    page.on('requestfinished', request => { const sample = requests.get(request); if (sample) sample.elapsedMs = performance.now() - playingAt - sample.startMs })
    await page.evaluate(() => {
      globalThis.__forexReplayPerformance = { samples: {}, counts: {} }
      const metrics = globalThis.__forexReplayPerformance
      new PerformanceObserver(list => { for (const entry of list.getEntries()) (metrics.samples['browser.longtask'] ??= []).push(entry.duration) }).observe({ type: 'longtask' })
      let previous = performance.now(), end = previous + 6400
      const tick = () => { const now = performance.now(); (metrics.samples['browser.timerLag'] ??= []).push(Math.max(0, now - previous - 50)); previous = now; if (now < end) setTimeout(tick, 50) }; setTimeout(tick, 50)
    })
    const started = performance.now(); playingAt = started; await page.getByRole('button', { name: 'Play', exact: true }).click()
    if (scenario === 'H') { const box = await page.locator('.chart-canvas').first().boundingBox(); assert.ok(box); await page.mouse.move(box.x + 200, box.y + 70) }
    await page.waitForTimeout(6200)
    const pauseAt = performance.now(); if (await page.getByRole('button', { name: 'Pause', exact: true }).isEnabled()) await page.getByRole('button', { name: 'Pause', exact: true }).click()
    const elapsed = performance.now() - started, pauseMs = performance.now() - pauseAt
    const after = await page.locator('[aria-label="Replay progress"]').textContent()
    const metrics = await page.evaluate(() => ({ ...globalThis.__forexReplayPerformance, heap: (performance as any).memory?.usedJSHeapSize }))
    capturingCheckpoints = false
    const observations = Number(after!.split('/')[0]) - Number(before!.split('/')[0])
    results.app.push({ days, scenario, frames, speed, observations, elapsed, observationsPerSecond: observations / elapsed * 1000, pauseMs, metrics, checkpoints })
    await writeFile(`/tmp/task19-${label}.json`, JSON.stringify(results, null, 2))
    assert.ok(observations > 0); console.log(JSON.stringify({ phase: 'app', days, scenario, observations, elapsed, pauseMs }))
    if (days === 90 && scenario === 'C') {
      await page.getByRole('button', { name: 'Next Min', exact: true }).click()
      assert.equal(Number((await page.locator('[aria-label="Replay progress"]').textContent())!.split('/')[0]), Number(after!.split('/')[0]) + 1)
      await page.getByRole('button', { name: 'Save now', exact: true }).click(); await page.locator('.session-status strong').filter({ hasText: /^Saved$/ }).waitFor()
      for (const width of [1440, 1100]) { await page.setViewportSize({ width, height: 1000 }); await page.screenshot({ path: `/tmp/task19-${label}-${width}.png`, fullPage: true }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width) }
      assert.equal(await page.locator('.tv-lightweight-charts').count(), 3)
      if (process.env.VERIFY) results.verification = await verifyReplayWorkspace(page)
    }
    await context.close()
  }
  }
  results.errors = errors; assert.deepEqual(errors, [])
  await writeFile(`/tmp/task19-${label}.json`, JSON.stringify(results, null, 2))
} finally { globalThis.fetch = nativeFetch; await browser.close(); await vite.close(); child.kill('SIGKILL'); await new Promise<void>(r => child.exitCode !== null ? r() : child.once('exit', () => r())); await rm(directory, { recursive: true, force: true }) }
