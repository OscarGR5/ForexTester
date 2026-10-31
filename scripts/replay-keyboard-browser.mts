import '../backend/src/environment.js'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer, preview } from 'vite'
import { createApp } from '../backend/src/app.js'
import { LocalArchive } from '../backend/src/localArchive.js'
import { SessionStorage } from '../backend/src/sessionStorage.js'
import { historyCandles } from '../frontend/src/history.js'
import { nextCandleIndex, previousCandleIndex } from '../frontend/src/candleNavigation.js'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core')
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/home/admin/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome', headless: true, args: ['--no-sandbox'] })
const production = process.env.REPLAY_BROWSER_MODE === 'production'
const output = process.env.BROWSER_OUTPUT ?? '/tmp/forextester-replay-keyboard'
await mkdir(output, { recursive: true })
const reports: unknown[] = []
try {
  for (const width of [1100, 1440]) {
    const directory = await mkdtemp(join(tmpdir(), 'forextester-keyboard-'))
    const storage = new SessionStorage({ directory }), api = createApp(new LocalArchive(), undefined, storage)
    await new Promise<void>(done => api.listen(0, '127.0.0.1', done))
    const apiOrigin = `http://127.0.0.1:${(api.address() as { port: number }).port}`
    const serverOptions = { host: '127.0.0.1', port: 0, proxy: { '/api': { target: apiOrigin, changeOrigin: false } } }
    const vite = production
      ? await preview({ configFile: false, root: resolve('frontend'), preview: serverOptions })
      : await createServer({ configFile: false, root: resolve('frontend'), server: serverOptions })
    if ('listen' in vite) await vite.listen()
    const origin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`
    const context = await browser.newContext({ viewport: { width, height: width === 1100 ? 800 : 1000 } })
    const page = await context.newPage(), errors: string[] = [], external: string[] = [], historyHeads: number[] = []
    const cases: { ctrl: boolean; held: boolean }[] = []
    page.on('pageerror', error => errors.push(error.stack ?? error.message))
    page.on('console', message => { if (message.type() === 'error' && /Maximum update depth|Too many re-renders/.test(message.text())) errors.push(message.text()) })
    page.on('response', response => { if (response.request().method() === 'HEAD' && /\/api\/storage\/history\//.test(response.url())) historyHeads.push(response.status()) })
    await page.route('**/*', route => {
      if (route.request().url().startsWith(origin)) return route.continue()
      external.push(route.request().url()); return route.abort()
    })
    const saved = async (index?: number) => {
      let observed: number | null | undefined
      for (let attempt = 0; attempt < 600; attempt++) {
        assert.deepEqual(errors, [])
        const record = (await storage.list()).sessions[0]
        observed = record?.checkpoint.replay.index
        const clock = await page.locator('.replay-clock').textContent()
        if (await page.locator('.save-state').textContent() === 'Saved' && record?.checkpoint.lifecycle === 'trading' &&
          clock === new Date(record.checkpoint.replay.timestamp!).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' &&
          (index === undefined || record.checkpoint.replay.index === index)) return record
        await delay(25)
      }
      throw Error(`Checkpoint did not reach index ${index}; last stored index ${observed}`)
    }
    const arrows = async (key: 'ArrowLeft' | 'ArrowRight', ctrl: boolean, held: boolean, steps: number) => {
      await page.keyboard.down('Shift')
      if (ctrl) await page.keyboard.down('Control')
      for (let step = 0; step < steps; step++) {
        if (held) await page.keyboard.down(key)
        else await page.keyboard.press(key)
        assert.deepEqual(errors, [])
      }
      if (held) await page.keyboard.up(key)
      if (ctrl) await page.keyboard.up('Control')
      await page.keyboard.up('Shift')
    }
    try {
      await page.goto(origin)
      await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.setup-footer .primary-action')?.disabled)
      await page.getByRole('button', { name: '7 days', exact: true }).click()
      await page.locator('.setup-advanced summary').click()
      await page.locator('input[name="chart-count"][value="3"]').check()
      await page.locator('.setup-advanced summary').click()
      await page.getByRole('button', { name: 'Start backtest', exact: true }).click()
      await page.locator('.phase-trading').waitFor({ timeout: 30_000 })
      let record = await saved()
      const source = historyCandles(await storage.getHistory(record.historyId))
      const initial = record.checkpoint.replay.index!
      await page.getByLabel('Chart 1 timeframe', { exact: true }).selectOption('M5')
      await page.getByLabel('Chart 2 timeframe', { exact: true }).selectOption('H4')
      await page.locator('.chart-canvas').first().click({ position: { x: 150, y: 150 } })
      let index = initial
      // Separate native events commit without act(). Repeated down events have
      // repeat=true, matching an OS-held key while modifiers remain pressed.
      for (const ctrl of process.env.REPLAY_BROWSER_CTRL ? [process.env.REPLAY_BROWSER_CTRL === 'true'] : [false, true]) {
        const timeframe = ctrl ? 'M1' : 'M5'
        if (ctrl) await page.locator('.chart-canvas').nth(1).click({ position: { x: 150, y: 150 } })
        for (const held of process.env.REPLAY_BROWSER_HELD ? [process.env.REPLAY_BROWSER_HELD === 'true'] : [false, true]) {
          const beforeIndex = index
          await arrows('ArrowRight', ctrl, held, 100)
          // Existing replay guards coalesce events arriving before a commit.
          // Every committed cursor must still be an exact timeframe boundary.
          const targets = new Set<number>()
          for (let step = 0; step < 100; step++) { index = nextCandleIndex(source, index, timeframe); targets.add(index) }
          record = await saved()
          index = record.checkpoint.replay.index!
          assert(index > beforeIndex && targets.has(index), `Unexpected ${timeframe} cursor ${index}`)
          const before = record.checkpoint, review = previousCandleIndex(source, index, timeframe)
          await page.keyboard.press(`${ctrl ? 'Control+' : ''}Shift+ArrowLeft`)
          await page.locator('.history-review').waitFor()
          assert((await page.locator('.history-review').innerText()).includes(new Date(source[review].timestamp).toISOString().slice(0, 16).replace('T', ' ')))
          assert.equal(await page.getByRole('button', { name: 'Buy', exact: true }).isDisabled(), true)
          await page.keyboard.press(`${ctrl ? 'Control+' : ''}Shift+ArrowRight`)
          await page.locator('.history-review').waitFor({ state: 'hidden' })
          await arrows('ArrowLeft', ctrl, held, 80)
          await page.locator('.history-review').waitFor()
          record = await saved(index)
          assert.deepEqual(record.checkpoint.trading, before.trading)
          assert.deepEqual(record.checkpoint.equity, before.equity)
          assert.equal(record.checkpoint.executionCursor, before.executionCursor)
          await page.getByRole('button', { name: 'Return to current replay', exact: true }).click()
          await page.locator('.history-review').waitFor({ state: 'hidden' })
          cases.push({ ctrl, held })
          console.log(JSON.stringify({ width, production, ctrl, held, index, errors }))
        }
      }
      assert.deepEqual(await page.locator('select[aria-label$="timeframe"]').evaluateAll(selects => selects.map(select => (select as HTMLSelectElement).value)), ['M5', 'H4', 'H1'])
      assert.equal(await page.locator('.chart-pane').nth(cases.at(-1)!.ctrl ? 1 : 0).getAttribute('data-active'), 'true')
      await page.getByRole('button', { name: 'Play', exact: true }).click()
      await page.keyboard.press('Control+Shift+ArrowRight')
      await page.locator('.keyboard-notice').waitFor()
      await page.getByRole('button', { name: 'Pause', exact: true }).click()
      await page.locator('.keyboard-notice').waitFor({ state: 'hidden' })
      record = await saved()
      const checkpoint = record.checkpoint
      await page.screenshot({ path: `${output}/${production ? 'production' : 'development'}-${width}.png`, fullPage: true })
      await page.reload()
      await page.getByRole('button', { name: 'Resume backtest', exact: true }).click()
      await page.locator('.phase-trading').waitFor()
      record = await saved(checkpoint.replay.index!)
      assert.deepEqual(record.checkpoint.trading, checkpoint.trading)
      assert.equal(record.checkpoint.executionCursor, checkpoint.executionCursor)
      assert.deepEqual(record.checkpoint.equity, checkpoint.equity)
      assert.deepEqual(errors, []); assert.deepEqual(external, [])
      assert(historyHeads.includes(404), 'Initial history HEAD must retain its expected 404')
      reports.push({ width, production, cases, initialIndex: initial, finalIndex: record.checkpoint.replay.index,
        nativeForwardEvents: cases.length * 100, nativeBackwardEvents: cases.length * 80, historyHeads, errors, external })
    } catch (error) {
      console.error(JSON.stringify({ width, production, errors, historyHeads }, null, 2)); throw error
    } finally {
      await context.close()
      if ('close' in vite) await vite.close()
      else await new Promise<void>(done => vite.httpServer.close(() => done()))
      await new Promise<void>(done => { api.close(() => done()); api.closeAllConnections() })
      await storage.close(); await rm(directory, { recursive: true, force: true })
    }
  }
  await writeFile(`${output}/${production ? 'production' : 'development'}.json`, JSON.stringify(reports, null, 2) + '\n')
  console.log(JSON.stringify(reports, null, 2))
} finally { await browser.close() }
