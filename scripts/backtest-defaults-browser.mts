import '../backend/src/environment.js'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { nextCandleIndex } from '../frontend/src/candleNavigation.js'
import { historyCandles } from '../frontend/src/history.js'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'
import { createApp } from '../backend/src/app.js'
import { LocalArchive } from '../backend/src/localArchive.js'
import { SessionStorage } from '../backend/src/sessionStorage.js'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core')
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/home/admin/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome', headless: true, args: ['--no-sandbox'] })
const output = process.env.BROWSER_OUTPUT ?? 'docs/backtest-warmup-chart-defaults'
await mkdir(output, { recursive: true })
const reports: unknown[] = []

try {
  for (const width of [1100, 1440]) {
    const height = width === 1100 ? 800 : 1000
    const directory = await mkdtemp(join(tmpdir(), `forextester-defaults-${width}-`))
    const storage = new SessionStorage({ directory }), api = createApp(new LocalArchive(), undefined, storage)
    await new Promise<void>(resolveListen => api.listen(0, '127.0.0.1', resolveListen))
    const apiOrigin = `http://127.0.0.1:${(api.address() as { port: number }).port}`
    const vite = await createServer({ configFile: false, root: resolve('frontend'), server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: apiOrigin, changeOrigin: false } } } })
    await vite.listen()
    const origin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`
    const context = await browser.newContext({ viewport: { width, height } }), page = await context.newPage()
    const requests: string[] = [], externalRequests: string[] = [], pageErrors: string[] = []
    page.on('request', request => {
      requests.push(request.url())
      if (!request.url().startsWith(origin) && !request.url().startsWith('data:')) externalRequests.push(request.url())
    })
    page.on('pageerror', error => pageErrors.push(error.message))
    const timeframes = () => page.locator('select[aria-label$="timeframe"]').evaluateAll(selects => selects.map(select => (select as HTMLSelectElement).value))
    const checked = (label: string) => page.getByLabel(label, { exact: true }).isChecked()
    const selectCount = async (count: number) => {
      await page.locator(`input[name="chart-count"][value="${count}"]`).check()
      await page.locator('.chart-pane').nth(count - 1).waitFor()
      assert.equal(await page.locator('.chart-pane').count(), count)
    }
    try {
      await page.goto(origin)
      await page.getByRole('button', { name: 'Start backtest', exact: true }).waitFor()
      await page.waitForFunction(() => !(document.querySelector('#setup-form')?.closest('fieldset') as HTMLFieldSetElement)?.disabled)
      await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.setup-footer .primary-action')?.disabled)
      assert.equal(await page.getByLabel('Backtest name', { exact: true }).inputValue(), 'Untitled backtest')
      assert.equal(await page.getByLabel('Round-trip commission (USD per standard lot)', { exact: true }).inputValue(), '7')
      assert.equal(await page.locator('input[name="chart-count"][value="2"]').isChecked(), true)
      assert.equal(await page.getByRole('button', { name: '180 days', exact: true }).isVisible(), true)
      assert.equal(requests.filter(url => url.includes('/api/history?')).length, 0)
      for (const days of [7, 30, 90, 180, 365]) {
        await page.getByRole('button', { name: `${days} days`, exact: true }).click()
        assert((await page.locator('.period-shortcuts').innerText()).includes(`${days} calendar days`))
        assert.equal(await page.getByRole('button', { name: 'Start backtest', exact: true }).isEnabled(), true)
      }
      await page.getByRole('button', { name: 'Random Range', exact: true }).click()
      assert((await page.locator('.period-shortcuts').innerText()).includes('120 calendar days'))
      assert.equal(requests.filter(url => url.includes('/api/history?')).length, 0)
      await page.getByRole('button', { name: '7 days', exact: true }).click()
      await page.screenshot({ path: `${output}/setup-${width}.png`, fullPage: true })
      await page.locator('.setup-account').scrollIntoViewIfNeeded()
      await page.screenshot({ path: `${output}/setup-details-${width}.png`, fullPage: true })

      await page.getByRole('button', { name: 'Start backtest', exact: true }).click()
      await page.locator('.phase-trading').waitFor({ timeout: 30_000 })
      await page.locator('.chart-pane').nth(1).waitFor()
      assert.deepEqual(await timeframes(), ['H4', 'D1'])
      assert.equal(await checked('Chart 1 Ichimoku'), true); assert.equal(await checked('Chart 2 Ichimoku'), true)
      const saved = async (timestamp?: number) => {
        for (let attempt = 0; attempt < 400; attempt++) {
          const record = (await storage.list()).sessions[0]
          if (await page.locator('.save-state').textContent() === 'Saved' && record?.checkpoint.lifecycle === 'trading' &&
            (timestamp === undefined || record.checkpoint.replay.timestamp === timestamp)) return record
          await delay(25)
        }
        throw Error('Replay checkpoint did not match the displayed navigation')
      }
      let checkpoint = await saved()
      const observations = historyCandles(await storage.getHistory(checkpoint.historyId))
      for (const focused of [0, 1]) {
        await page.locator('.chart-pane').nth(focused).locator('.chart-canvas').click({ position: { x: 150, y: 100 } })
        const before = checkpoint.checkpoint.replay.index!, expected = observations[before + 1].timestamp
        await page.keyboard.press('Control+Shift+ArrowRight')
        checkpoint = await saved(expected)
        assert.equal(checkpoint.checkpoint.replay.index, before + 1)
        assert.deepEqual(await timeframes(), ['H4', 'D1'])
        assert.equal(await page.locator('.chart-pane').nth(focused).getAttribute('data-active'), 'true')
        await page.keyboard.press('Control+Shift+ArrowLeft')
        assert((await page.locator('.history-review').innerText()).includes(new Date(observations[before].timestamp).toISOString().slice(0, 16).replace('T', ' ')))
        assert.equal(await page.getByRole('button', { name: 'Next Min', exact: true }).isDisabled(), true)
        const reviewed = await saved(expected)
        assert.deepEqual(reviewed.checkpoint.trading, checkpoint.checkpoint.trading)
        assert.equal(reviewed.checkpoint.executionCursor, checkpoint.checkpoint.executionCursor)
        await page.keyboard.press('Control+Shift+ArrowRight')
        await page.locator('.history-review').waitFor({ state: 'hidden' })
      }
      const beforeButton = checkpoint.checkpoint.replay.index!
      await page.getByRole('button', { name: 'Next Min', exact: true }).click()
      checkpoint = await saved(observations[beforeButton + 1].timestamp)
      await page.locator('.chart-pane').first().locator('.chart-canvas').click({ position: { x: 150, y: 100 } })
      const expectedH4 = nextCandleIndex(observations, checkpoint.checkpoint.replay.index!, 'H4')
      await page.keyboard.press('Shift+ArrowRight')
      checkpoint = await saved(observations[expectedH4].timestamp)
      await page.getByLabel('Execution details', { exact: true }).click()
      assert((await page.locator('.execution-popover').innerText()).includes('Ctrl + Shift + Left/Right'))
      assert((await page.locator('.execution-popover').innerText()).includes('does not rewind trade execution'))
      await page.getByLabel('Execution details', { exact: true }).click()
      await page.screenshot({ path: `${output}/charts-2-${width}.png`, fullPage: true })
      const two = await page.locator('.chart-pane').evaluateAll(panes => panes.map(pane => pane.getBoundingClientRect().toJSON()))
      assert(Math.abs(two[0].y - two[1].y) < 2 && two[1].x > two[0].x)

      await selectCount(1)
      assert.deepEqual(await timeframes(), ['D1']); assert.equal(await checked('Chart 1 Ichimoku'), true)
      await page.screenshot({ path: `${output}/charts-1-${width}.png`, fullPage: true })
      await page.getByLabel('Chart 1 timeframe', { exact: true }).selectOption('H1')

      await selectCount(3)
      assert.deepEqual(await timeframes(), ['M5', 'H4', 'H1'])
      for (const label of ['Chart 1 BB #1', 'Chart 1 BB #2', 'Chart 1 Stochastic', 'Chart 2 Ichimoku', 'Chart 3 Ichimoku']) assert.equal(await checked(label), true)
      await page.screenshot({ path: `${output}/charts-3-${width}.png`, fullPage: true })
      const three = await page.locator('.chart-pane').evaluateAll(panes => panes.map(pane => pane.getBoundingClientRect().toJSON()))
      assert(three[1].x > three[0].x && three[2].x === three[1].x && three[2].y > three[1].y && three[0].height > three[1].height)

      await selectCount(1); assert.deepEqual(await timeframes(), ['H1'])
      await selectCount(2); assert.deepEqual(await timeframes(), ['H4', 'D1'])
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
      const paidRequests = requests.filter(url => /hist\.databento|\/history\/(download|estimate)|pricing|purchase/i.test(url))
      assert.equal(overflow, false); assert.deepEqual(externalRequests, []); assert.deepEqual(paidRequests, []); assert.deepEqual(pageErrors, [])
      reports.push({ width, height, setupDefaults: { commission: 7, chartCount: 2 }, presets: [7, 30, 90, 180, 365], randomRangeHistoryRequestsBeforeStart: 0, m1Shortcuts: { focusedTimeframes: ['H4', 'D1'], reviewPreservesExecution: true, nextMinAdvancesOneObservation: true, shiftH4Unchanged: true },
        layouts: { one: ['D1'], two: ['H4', 'D1'], three: ['M5', 'H4', 'H1'] }, customizationRestored: { one: ['H1'], two: ['H4', 'D1'] },
        localHistoryRequests: requests.filter(url => url.includes('/api/history?')).length, paidRequests, externalRequests, pageErrors, horizontalOverflow: overflow })
    } catch (error) {
      await page.screenshot({ path: `${output}/failure-${width}.png`, fullPage: true }).catch(() => {})
      console.error(await page.locator('body').innerText().catch(() => ''))
      throw error
    } finally {
      await context.close(); await vite.close()
      await new Promise<void>(resolveClose => { api.close(() => resolveClose()); api.closeAllConnections() })
      await storage.close(); await rm(directory, { recursive: true, force: true })
    }
  }
  await writeFile(`${output}/browser-verification.json`, `${JSON.stringify(reports, null, 2)}\n`)
  console.log(JSON.stringify(reports, null, 2))
} finally { await browser.close() }
