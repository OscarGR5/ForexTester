// Production App, installed local history, isolated temporary session storage.
import '../backend/src/environment.js'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { preview } from 'vite'
import { createApp } from '../backend/src/app.js'
import { LocalArchive } from '../backend/src/localArchive.js'
import { SessionStorage } from '../backend/src/sessionStorage.js'
import type { SessionRecord } from '../frontend/src/sessionTypes.js'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core')
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/home/admin/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome', headless: true, args: ['--no-sandbox'] })
const output = 'docs/close-all'
await mkdir(output, { recursive: true })
const reports: unknown[] = []
try {
  for (const width of [1100, 1440]) {
    const directory = await mkdtemp(join(tmpdir(), `forextester-close-all-${width}-`))
    const storage = new SessionStorage({ directory }), archive = new LocalArchive()
    const api = createApp(archive, undefined, storage)
    await new Promise<void>(done => api.listen(0, '127.0.0.1', done))
    const apiOrigin = `http://127.0.0.1:${(api.address() as { port: number }).port}`
    const vite = await preview({ configFile: false, root: resolve('frontend'), preview: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: apiOrigin, changeOrigin: false } } } })
    const origin = `http://127.0.0.1:${(vite.httpServer.address() as { port: number }).port}`
    const context = await browser.newContext({ viewport: { width, height: 1000 } }), page = await context.newPage()
    const errors: string[] = [], dialogs: string[] = [], external: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss() })
    await page.route('**/*', route => {
      if (!route.request().url().startsWith(origin) && !route.request().url().startsWith('data:')) { external.push(route.request().url()); return route.abort() }
      return route.continue()
    })
    const button = (name: string) => page.getByRole('button', { name, exact: true })
    async function saved(predicate: (record: SessionRecord) => boolean) {
      for (let attempt = 0; attempt < 400; attempt++) {
        if (await page.locator('.save-state').textContent() === 'Saved') {
          const record = (await storage.list()).sessions[0]
          if (record && predicate(record)) return record
        }
        await delay(25)
      }
      throw Error('Saved checkpoint did not reach the expected trading state')
    }
    try {
      await page.goto(origin)
      await page.waitForFunction(() => { const button = document.querySelector<HTMLButtonElement>('.setup-footer .primary-action'), fieldset = document.querySelector<HTMLFieldSetElement>('.workspace-controls'); return button && fieldset && !button.disabled && !fieldset.disabled })
      await page.getByLabel('Backtest name', { exact: true }).fill(`Close all ${width}`)
      await page.getByLabel('Round-trip commission (USD per standard lot)', { exact: true }).fill('7')
      await button('Start backtest').click()
      await page.locator('.phase-trading').waitFor({ timeout: 60_000 })
      let record = await saved(r => r.checkpoint.replay.started)
      const outcomes: unknown[] = []
      for (let cycle = 0; cycle < 3; cycle++) {
        const previousClosed = record.checkpoint.trading.closed.length
        const quote = record.checkpoint.trading.quote
        assert(quote && 'priceModel' in quote && quote.trade)
        const stop = (quote.trade.close - .01).toFixed(7)
        for (let entry = 0; entry < 2; entry++) {
          await button('Buy').click()
          await page.getByLabel('Enter price with keyboard').click()
          await page.getByLabel('SL price', { exact: true }).fill(stop)
          await button('Confirm order').click()
        }
        await button('Next Min').click()
        record = await saved(r => r.checkpoint.trading.positions.length === 2 && r.checkpoint.trading.pending.length === 0)
        if (cycle > 0) {
          for (const timeframe of ['M15', 'H1', 'M5']) {
            await page.getByLabel('Chart 1 timeframe', { exact: true }).selectOption(timeframe)
            await page.locator('.chart-canvas').first().click({ position: { x: 150, y: 150 } })
            const timestamp = record.checkpoint.replay.timestamp!
            await page.keyboard.press('Shift+ArrowRight')
            record = await saved(r => r.checkpoint.replay.timestamp! > timestamp)
            assert.equal(record.checkpoint.trading.positions.length, 2)
          }
        }
        const before = record.checkpoint
        if (cycle === 0) await page.screenshot({ path: `${output}/two-open-${width}.png`, fullPage: true })
        await button('Close all').click()
        await page.waitForFunction(() => document.querySelectorAll('.active-positions button:disabled').length === 2)
        assert.equal(await button('Close all').isDisabled(), true)
        await page.locator('.close-all').evaluate((element: HTMLButtonElement) => { element.click(); element.click() })
        record = await saved(r => r.checkpoint.trading.positions.length === 2 && r.checkpoint.trading.positions.every(p => p.closeRequestedAt === before.replay.timestamp))
        assert.equal(record.checkpoint.trading.closed.length, previousClosed)
        if (cycle === 1) {
          const queued = record.checkpoint.trading
          await page.reload(); await button('Resume backtest').click()
          await page.locator('.phase-trading').waitFor({ timeout: 60_000 })
          await page.waitForFunction(() => !document.querySelector<HTMLFieldSetElement>('.workspace-controls')?.disabled)
          assert.equal(await page.getByLabel('Replay status').textContent(), 'Paused')
          record = await saved(r => r.checkpoint.replay.timestamp === before.replay.timestamp)
          assert.deepEqual(record.checkpoint.trading, queued)
          assert.equal(await page.locator('.active-positions button').filter({ hasText: 'Close pending' }).count(), 2)
        }
        await button('Next Min').click()
        record = await saved(r => r.checkpoint.trading.closed.length === previousClosed + 2 && r.checkpoint.trading.positions.length === 0)
        const trades = record.checkpoint.trading.closed.slice(-2)
        assert.equal(trades[0].exitTime, trades[1].exitTime)
        assert(trades[0].exitTime > before.replay.timestamp!)
        for (const trade of trades) {
          assert.equal(trade.exitReason, 'manual')
          assert.equal(trade.totalCommissionUsd, trade.lots * 7)
          assert(Math.abs(trade.netPnlUsd - ((trade.exitPrice - trade.entryPrice) * 100_000 * trade.lots - trade.lots * 7)) < 1e-8)
        }
        outcomes.push({ cycle, queuedAt: before.replay.timestamp, exits: trades.map(p => ({ id: p.id, exitTime: p.exitTime, exitPrice: p.exitPrice, commission: p.totalCommissionUsd, netPnlUsd: p.netPnlUsd })), resumedQueuedCloses: cycle === 1 })
      }
      await page.screenshot({ path: `${output}/closed-${width}.png`, fullPage: true })
      assert.deepEqual(errors, []); assert.deepEqual(dialogs, []); assert.deepEqual(external, [])
      reports.push({ width, production: true, outcomes, errors, dialogs, external })
    } catch (error) { await page.screenshot({ path: `${output}/failure-${width}.png`, fullPage: true }); throw error }
    finally {
      await context.close()
      await new Promise<void>(done => { vite.httpServer.close(() => done()); vite.httpServer.closeAllConnections() })
      await new Promise<void>(done => { api.close(() => done()); api.closeAllConnections() })
      await storage.close()
    }
  }
  await writeFile(`${output}/browser-verification.json`, JSON.stringify(reports, null, 2) + '\n')
  console.log(JSON.stringify(reports, null, 2))
} finally { await browser.close() }
