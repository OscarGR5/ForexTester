// Offline synthetic fixtures, isolated filesystem sessions, real production App.
// No provider or historical-cache implementation is instantiated.
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer as createHttpServer } from 'node:http'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { sessionApi } from '../backend/src/sessionApi.js'
import { SessionStorage } from '../backend/src/sessionStorage.js'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core')
const directory = await mkdtemp(join(tmpdir(), 'forextester-results-dashboard-')), output = 'docs/results-dashboard'
await mkdir(output, { recursive: true })
const storage = new SessionStorage({ directory: join(directory, 'sessions') })
const evidence: any = { fixtures: 'tests/resultsFixture.ts: synthetic 6E weekday M1 prices, $100,000 initial balance, combined 2% risk budget, $7/lot round-trip commissions; fixed 2024 UTC dates', isolatedDirectory: directory,
  networkHistoryCalls: [], externalRequests: [], paidSubmissions: 0, errors: [], screenshots: [], checks: {} }
const backend = createHttpServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  if (await sessionApi(req, res, storage)) return
  if (req.url === '/api/history/calendar') { res.end(JSON.stringify({ days: [] })); return }
  evidence.networkHistoryCalls.push(req.url); res.writeHead(503); res.end(JSON.stringify({ error: 'Provider access is forbidden in verification' }))
})
await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve))
const backendPort = (backend.address() as { port: number }).port
const vite = await createServer({ configFile: false, root: 'frontend', cacheDir: join(directory, 'vite'), server: { watch: null, hmr: false, host: '127.0.0.1', port: 5196, strictPort: true,
  fs: { allow: [resolve('.')] }, proxy: { '/api': { target: `http://127.0.0.1:${backendPort}`, changeOrigin: false } } } })
await vite.listen()
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? '/home/admin/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell' })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true }), page = await context.newPage()
await page.addInitScript('globalThis.__name = target => target')
page.on('pageerror', error => evidence.errors.push(error.message))
page.on('dialog', dialog => dialog.accept())
await page.route('**/*', route => {
  const url = new URL(route.request().url())
  if (url.pathname === '/api/history/download') { evidence.paidSubmissions++; return route.abort() }
  if (url.hostname !== '127.0.0.1') { evidence.externalRequests.push(url.origin); return route.abort() }
  return route.continue()
})
const button = (name: string) => page.getByRole('button', { name, exact: true })
const saved = () => page.waitForFunction(() => document.querySelector('.save-state')?.textContent === 'Saved')
const fixtureModule = `/@fs/${resolve('tests/resultsFixture.ts')}`
async function record(id: string) { return (await (await fetch(`http://127.0.0.1:${backendPort}/api/storage/sessions/${id}`)).json()).record }
async function open(name: string) {
  await page.goto('http://127.0.0.1:5196')
  await page.locator('.saved-session').filter({ hasText: name }).getByRole('button', { name: 'Resume backtest', exact: true }).click()
}
async function capture(name: string, fullDashboard = false) {
  const path = `${output}/${name}.png`
  if (fullDashboard) {
    const previous = await page.evaluate(() => {
      const results = document.querySelector<HTMLElement>('.results-workspace')!, shell = document.querySelector<HTMLElement>('.app-shell')!
      const previous = { results: results.style.cssText, shell: shell.style.cssText }
      results.scrollTop = 0; results.style.overflow = 'visible'; results.style.flex = 'none'; results.style.height = 'auto'; shell.style.height = 'auto'
      return previous
    })
    await page.screenshot({ path, fullPage: true })
    await page.evaluate(previous => { document.querySelector<HTMLElement>('.results-workspace')!.style.cssText = previous.results; document.querySelector<HTMLElement>('.app-shell')!.style.cssText = previous.shell }, previous)
  } else await page.screenshot({ path })
  evidence.screenshots.push(path)
}
async function layout(width: number) {
  await page.setViewportSize({ width, height: 1000 }); await page.waitForTimeout(150)
  const result = await page.evaluate(() => {
    const results = document.querySelector<HTMLElement>('.results-workspace')!, header = document.querySelector('.app-header')!.getBoundingClientRect()
    const rect = (el: Element) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height, right: b.right, bottom: b.bottom } }
    return { pageWidth: document.documentElement.scrollWidth, width: innerWidth, scrollWidth: results.scrollWidth, contentWidth: results.clientWidth, scrollHeight: results.scrollHeight,
      headerBottom: header.bottom, results: rect(results), metrics: [...document.querySelectorAll('.results-primary-metrics > div')].map(rect),
      timelines: [...document.querySelectorAll<SVGSVGElement>('.results-timeline')].map(el => ({ ...rect(el), viewWidth: el.viewBox.baseVal.width })),
      pathLengths: [...document.querySelectorAll('.results-timeline path')].map(p => (p.getAttribute('d') ?? '').length), invalidPaths: [...document.querySelectorAll('.results-timeline path')].some(p => /NaN|Infinity|undefined/.test(p.getAttribute('d') ?? '')), svgNodes: document.querySelectorAll('.results-timeline *').length }
  })
  assert.equal(result.pageWidth, width); assert.equal(result.scrollWidth, result.contentWidth)
  assert.ok(result.results.y >= result.headerBottom); assert.equal(result.metrics.length, 6)
  assert.ok(result.metrics.every(b => b.bottom < 1000 && b.x >= 0 && b.right <= width))
  assert.ok(result.timelines.every(b => Math.abs(b.width - b.viewWidth) < 2)); assert.ok(result.svgNodes < 100)
  assert.equal(result.invalidPaths, false)
  evidence.checks[`layout-${width}`] = result
  await capture(`populated-${width}`)
}
try {
  await page.goto('http://127.0.0.1:5196'); await page.waitForFunction(() => !document.querySelector<HTMLFieldSetElement>('.workspace-controls')?.disabled)
  const fixtures = await page.evaluate(async fixtureModule => {
    const { resultsFixture } = await import(fixtureModule)
    const { DiskSessionStore } = await import('/src/diskSessionStore.ts')
    const { historyFingerprint, recordDigest } = await import('/src/sessionCodec.ts')
    const store = new DiskSessionStore(), fixtures: any = {}
    for (const kind of ['populated', 'empty', 'unfinished']) {
      const { history, snapshot } = resultsFixture(kind)
      const id = crypto.randomUUID(), historyId = await historyFingerprint(history)
      await store.cacheHistory(historyId, history)
      let record = await store.save({ id, name: `Synthetic ${kind} Results fixture`, createdAt: '2024-04-01T00:00:00.000Z', range: { from: history.tradingFrom, to: history.to }, historyId, totalCandles: history.candles.length }, snapshot, null)
      if (kind === 'populated') {
        // Digest-verified v1 finished checkpoint with position-scope preferences.
        const legacy = { ...record, schemaVersion: 1, revision: record.revision + 1, checkpoint: { ...record.checkpoint } }
        delete legacy.checkpoint.lifecycle
        legacy.digest = await recordDigest(legacy)
        record = await store.call(`/sessions/${id}/checkpoint`, 'PUT', { record: legacy, chunks: [], expectedRevision: record.revision })
      }
      fixtures[kind] = { id, completedSetups: record.completedSetups, observations: snapshot.ledger.count, positions: record.checkpoint.trading.positions.length, pending: record.checkpoint.trading.pending.length }
    }
    return fixtures
  }, fixtureModule)
  evidence.fixturesSummary = fixtures
  await open('Synthetic populated Results fixture'); await page.locator('.phase-finished').waitFor(); await saved()
  assert.equal(await page.locator('.results-navigation').count(), 0)
  assert.equal(await page.getByRole('button', { name: /^(Overview|Journal|Equity & drawdown)$/ }).count(), 0)
  assert.equal(await page.getByLabel('Statistics scope', { exact: true }).count(), 0)
  assert.equal(await page.locator('.results-breakdown').getAttribute('open'), null)
  for (const width of [1440, 1100, 1728, 1000]) await layout(width)
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.waitForTimeout(150)
  await capture('populated-dashboard', true)
  const before = await record(fixtures.populated.id)
  assert.equal(before.schemaVersion, 2); assert.equal(before.checkpoint.lifecycle, 'finished')
  assert.equal(before.checkpoint.workspace.statisticsScope, 'positions')
  const kpis = await page.locator('.results-primary-metrics').innerText()
  const paths = await page.locator('.results-timeline path').evaluateAll(paths => paths.map(p => p.getAttribute('d')))
  await page.reload(); await page.locator('.saved-session').filter({ hasText: 'Synthetic populated Results fixture' }).getByRole('button', { name: 'Resume backtest', exact: true }).click()
  await page.locator('.phase-finished').waitFor(); await saved(); await page.waitForTimeout(150)
  assert.equal(await page.locator('.results-primary-metrics').innerText(), kpis)
  assert.deepEqual(await page.locator('.results-timeline path').evaluateAll(paths => paths.map(p => p.getAttribute('d'))), paths)
  const restored = await record(fixtures.populated.id)
  assert.deepEqual(restored.checkpoint.trading, before.checkpoint.trading); assert.deepEqual(restored.checkpoint.equity, before.checkpoint.equity)
  evidence.checks.legacyFinishedRestorationAndDeterminism = true
  await button('USD').click(); assert.match(await page.locator('.results-timeline').first().getAttribute('aria-label'), /USD/)
  await button('%').click()
  await page.locator('.results-timeline').first().focus(); await page.keyboard.press('End')
  assert.equal(await page.locator('.results-crosshair').count(), 2)
  assert.equal(await page.locator('.results-chart-readout time').count(), 2)
  await page.keyboard.press('ArrowLeft')
  assert.equal(await page.locator('.results-chart-readout time').first().innerText(), await page.locator('.results-chart-readout time').last().innerText())
  await page.keyboard.press('Escape'); evidence.checks.unitsAndSynchronizedKeyboardHover = true
  await page.locator('.results-breakdown > summary').click()
  assert.equal(await page.locator('[data-setup-id]').count(), before.checkpoint.trading.setups.length)
  const firstId = before.checkpoint.trading.setups[0].id
  await page.getByRole('button', { name: `Details for setup ${firstId}`, exact: true }).click()
  const positions = [...before.checkpoint.trading.closed, ...before.checkpoint.trading.positions].filter(p => p.setupId === firstId)
  for (const p of positions) {
    const details = page.getByRole('article', { name: `Position details ${p.id}`, exact: true })
    assert.ok(await details.isVisible()); assert.match(await details.innerText(), /Original gross risk/)
  }
  assert.equal(await page.locator('textarea').count(), 0)
  await page.locator('.results-breakdown').scrollIntoViewIfNeeded(); await capture('expanded-setup-breakdown')
  await capture('expanded-dashboard', true); evidence.checks.setupDetails = positions.map(p => p.id)
  const downloadPromise = page.waitForEvent('download'); await button('Export trades').click(); const download = await downloadPromise
  const stream = await download.createReadStream(); let csv = ''; for await (const chunk of stream) csv += chunk.toString()
  assert.ok(csv.startsWith('setup_id,position_id,symbol,direction,volume_lots,')); assert.ok(csv.includes("'=Stored note remains CSV-safe"))
  assert.equal(csv.split('\r\n').filter(Boolean).length - 1, before.checkpoint.trading.closed.length + before.checkpoint.trading.positions.length)
  evidence.checks.csv = { filename: download.suggestedFilename(), exportedPositions: csv.split('\r\n').filter(Boolean).length - 1 }
  await button('Save now').click(); await saved(); evidence.checks.headerSave = true
  await open('Synthetic empty Results fixture'); await page.locator('.phase-finished').waitFor(); await saved()
  assert.match(await page.locator('[aria-label="R by Setup"]').innerText(), /No completed setups/)
  assert.equal(await button('Export trades').isDisabled(), true); await capture('empty-session', true)
  const unfinishedBefore = await record(fixtures.unfinished.id)
  await open('Synthetic unfinished Results fixture'); await page.locator('.phase-trading').waitFor(); await saved()
  await button('Finish backtest').click(); await page.locator('.phase-finished').waitFor(); await saved()
  const unfinishedAfter = await record(fixtures.unfinished.id)
  assert.deepEqual(unfinishedAfter.checkpoint.trading, unfinishedBefore.checkpoint.trading)
  assert.deepEqual(unfinishedAfter.checkpoint.equity, unfinishedBefore.checkpoint.equity)
  assert.match(await page.locator('.results-unfinished').innerText(), /1 open positions · 1 pending entries · 1 partially completed setups/)
  assert.match(await page.locator('.results-sample').innerText(), /0 completed setups/)
  await capture('unfinished-session', true)
  evidence.checks.finishPreservesOpenPartialPendingAndLedger = { open: unfinishedAfter.checkpoint.trading.positions.length, pending: unfinishedAfter.checkpoint.trading.pending.length, closed: unfinishedAfter.checkpoint.trading.closed.length }
  await page.reload(); await page.locator('.saved-session').filter({ hasText: 'Synthetic unfinished Results fixture' }).getByRole('button', { name: 'Resume backtest', exact: true }).click()
  await page.locator('.phase-finished').waitFor(); await saved()
  assert.deepEqual((await record(fixtures.unfinished.id)).checkpoint.trading, unfinishedAfter.checkpoint.trading)
  assert.deepEqual(evidence.errors, []); assert.deepEqual(evidence.externalRequests, []); assert.deepEqual(evidence.networkHistoryCalls, []); assert.equal(evidence.paidSubmissions, 0)
  await writeFile(`${output}/browser-evidence.json`, JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify({ checks: Object.keys(evidence.checks), fixtures: fixtures, screenshots: evidence.screenshots.length, errors: evidence.errors }, null, 2))
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {})
  await writeFile(`${output}/browser-failure.json`, JSON.stringify({ ...evidence, failure: String(error) }, null, 2) + '\n'); throw error
} finally {
  await browser.close(); await vite.close(); await new Promise<void>(resolve => { backend.close(() => resolve()); backend.closeAllConnections() }); await storage.close()
}
