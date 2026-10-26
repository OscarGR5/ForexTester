import '../backend/src/environment.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'
import { createApp } from '../backend/src/app.js'
import { LocalArchive } from '../backend/src/localArchive.js'
import { SessionStorage } from '../backend/src/sessionStorage.js'
import { historyFingerprint, recordDigest } from '../frontend/src/sessionCodec.js'
import { createTradingState } from '../frontend/src/trading.js'
import { createEquityLedger } from '../frontend/src/equity.js'
import { defaultWorkspace } from '../frontend/src/uiPreferences.js'
import { equitySummary, type SessionRecord } from '../frontend/src/sessionTypes.js'
import { shiftDate } from '../frontend/src/workflow.js'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core')
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/home/admin/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome', headless: true, args: ['--no-sandbox'] })
const output = 'docs/pr41-fixes'
await mkdir(output, { recursive: true })
const reports: unknown[] = []
const archive = new LocalArchive(), calendar = await archive.calendar()
const from = calendar.days[0].date, to = shiftDate(from, 1)
const history = { ...await archive.load('EURUSD', from, to, from), tradingFrom: from }
const historyId = await historyFingerprint(history)

try {
  for (const width of [1100, 1440]) for (const count of [1, 2, 3] as const) {
    const height = width === 1100 ? 800 : 1000
    const directory = await mkdtemp(join(tmpdir(), `forextester-pr41-${width}-${count}-`))
    const storage = new SessionStorage({ directory })
    const workspace = defaultWorkspace(), mode = workspace.chartModes![String(count) as '1' | '2' | '3']!
    if (count === 1) { mode.timeframes[0] = 'M1'; mode.indicators[0] = { M1: mode.indicators[0].D1! } }
    for (const pane of mode.indicators) for (const settings of Object.values(pane)) for (const group of Object.values(settings!)) group.enabled = false
    Object.assign(workspace, { chartCount: count, ...mode })
    const ledger = createEquityLedger(100000), createdAt = new Date().toISOString()
    const record: SessionRecord = { id: randomUUID(), name: `Zero indicators ${count}`, createdAt, savedAt: createdAt, revision: 1, schemaVersion: 2,
      symbol: 'EURUSD', range: { from, to }, historyId, totalCandles: history.candles.length, completedSetups: 0, status: 'paused', chunkHashes: [], digest: '',
      checkpoint: { lifecycle: 'setup', workspace, trading: { ...createTradingState(), executionModel: 'single-price-m1-v1', commission: { roundTripUsdPerLot: 3.75 } },
        equity: equitySummary(ledger), executionCursor: 0, replay: { started: false, index: null, timestamp: null, startIndex: 0, startTimestamp: history.candles[0].timestamp, speed: 1, complete: false, playing: false } } }
    record.digest = await recordDigest(record)
    await storage.putHistory(historyId, history); await storage.save(record, [], 0)
    const api = createApp(archive, undefined, storage)
    await new Promise<void>(done => api.listen(0, '127.0.0.1', done))
    const vite = await createServer({ configFile: false, root: resolve('frontend'), server: { host: '127.0.0.1', port: 0,
      proxy: { '/api': { target: `http://127.0.0.1:${(api.address() as { port: number }).port}`, changeOrigin: false } } } })
    await vite.listen()
    const origin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`
    const context = await browser.newContext({ viewport: { width, height } }), page = await context.newPage()
    page.setDefaultTimeout(60000)
    const requests: string[] = [], external: string[] = [], errors: string[] = []
    await context.route('**/*', route => {
      if (!route.request().url().startsWith(origin)) { external.push(route.request().url()); return route.abort() }
      return route.continue()
    })
    page.on('request', request => requests.push(request.url()))
    page.on('pageerror', error => errors.push(error.message))
    try {
      await page.goto(origin)
      await page.getByRole('button', { name: 'Resume backtest', exact: true }).click()
      const start = page.getByRole('button', { name: 'Start backtest', exact: true })
      await page.waitForFunction(expected => document.querySelector<HTMLInputElement>('[aria-label="From"]')?.value === expected && !document.querySelector<HTMLButtonElement>('.setup-footer .primary-action')?.disabled, from)
      assert.equal(await page.getByLabel('From', { exact: true }).inputValue(), from)
      assert((await page.locator('.period-readiness').innerText()).includes('No indicator warm-up required'))
      await page.locator('.setup-advanced > summary').click()
      const other = count === 1 ? 2 : 1
      await page.locator(`input[name="chart-count"][value="${other}"]`).check()
      assert.equal(await start.isDisabled(), true)
      assert((await page.locator('.period-readiness').innerText()).includes('Insufficient completed historical candles'))
      await page.locator(`input[name="chart-count"][value="${count}"]`).check()
      assert.equal(await start.isEnabled(), true)
      assert.equal(requests.filter(url => url.includes('/api/history?')).length, 0)
      await page.screenshot({ path: `${output}/zero-setup-${count}-${width}.png`, fullPage: true })
      const startedName = `Started zero indicators ${count}`
      await page.getByLabel('Backtest name', { exact: true }).fill(startedName)
      await start.click()
      await page.locator('.phase-trading').waitFor()
      await page.waitForFunction(() => document.querySelector('.save-state')?.textContent === 'Saved')
      assert.equal(await page.locator('.chart-pane').count(), count)
      for (let chart = 1; chart <= count; chart++) for (const indicator of ['BB #1', 'BB #2', 'Stochastic', 'Ichimoku']) assert.equal(await page.getByLabel(`Chart ${chart} ${indicator}`, { exact: true }).isChecked(), false)
      const historyRequests = requests.filter(url => url.includes('/api/history?'))
      assert.equal(historyRequests.length, 1)
      const query = new URL(historyRequests[0]).searchParams
      assert.equal(query.get('from'), from); assert.equal(query.get('tradingFrom'), from)
      await page.screenshot({ path: `${output}/zero-trading-${count}-${width}.png`, fullPage: true })
      const before = (await storage.list()).sessions.find(saved => saved.checkpoint.lifecycle === 'trading')!
      assert.equal(before.checkpoint.replay.startIndex, 0)
      assert.equal(before.checkpoint.trading.commission.roundTripUsdPerLot, 3.75)
      await page.reload()
      await page.locator('.saved-session').filter({ has: page.getByRole('button', { name: `Rename backtest ${startedName}`, exact: true }) }).first().getByRole('button', { name: 'Resume backtest', exact: true }).click()
      await page.locator('.phase-trading').waitFor()
      assert.equal(await page.locator('.chart-pane').count(), count)
      assert.equal(requests.filter(url => url.includes('/api/history?')).length, 1)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      assert.deepEqual(external, []); assert.deepEqual(errors, [])
      assert.deepEqual(requests.filter(url => /\/history\/(download|estimate)|pricing|purchase/i.test(url)), [])
      console.log(`Verified ${count} charts at ${width}px`)
      reports.push({ width, height, chartCount: count, firstDate: from, firstObservation: history.candles[0].timestamp, historyRequests: 1,
        requestFrom: query.get('from'), tradingFrom: query.get('tradingFrom'), startIndex: 0, restoredCommission: 3.75,
        indicatorsDisabled: true, warmupModeSwitching: true, restoreHistoryRequests: 0, external, errors })
    } catch (error) {
      await page.screenshot({ path: `${output}/failure-${count}-${width}.png`, fullPage: true }).catch(() => {})
      console.error(await page.locator('body').innerText().catch(() => ''))
      throw error
    } finally {
      await context.close(); await vite.close()
      await new Promise<void>(done => { api.close(() => done()); api.closeAllConnections() })
      await storage.close(); await rm(directory, { recursive: true, force: true })
    }
  }
  await writeFile(`${output}/zero-indicator-browser.json`, `${JSON.stringify(reports, null, 2)}\n`)
  console.log(JSON.stringify(reports, null, 2))
} finally { await browser.close() }
