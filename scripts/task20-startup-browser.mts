import { chromium } from 'playwright-core'
import { createServer } from 'vite'
import { createApp } from '../backend/src/app'
import { HistoryService } from '../backend/src/history'
import { FixtureDatabento } from '../tests/databentoFixture'
import { SessionStorage } from '../backend/src/sessionStorage'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const directory = await mkdtemp(join(tmpdir(), 'forextester-startup-'))
const api = createApp(new HistoryService(new FixtureDatabento()), undefined, new SessionStorage({ directory }))
await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve))
const port = (api.address() as { port: number }).port
const vite = await createServer({ configFile: false, root: 'frontend', cacheDir: join(directory, 'vite'),
  optimizeDeps: { include: ['react', 'react-dom/client', 'lightweight-charts', 'technicalindicators'] },
  server: { watch: null, hmr: false, host: '127.0.0.1', port: 5191, strictPort: true, proxy: { '/api': { target: `http://127.0.0.1:${port}`, changeOrigin: false } } } })
await vite.listen()
const browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors: string[] = [], historyRequests: string[] = []
page.on('pageerror', error => errors.push(error.message))
page.on('request', request => { if (request.url().includes('/api/history?')) historyRequests.push(request.url()) })
await page.addInitScript('globalThis.__name = target => target')
try {
  await page.goto('http://127.0.0.1:5191')
  await page.waitForFunction(() => !document.querySelector<HTMLFieldSetElement>('.workspace-controls')?.disabled)
  // Seed only this isolated browser profile, never the user's real sessions.
  await page.evaluate(async () => {
    const { SessionStore } = await import('/src/sessionStore.ts')
    const { sessionHistory, sessionSimulation } = await import('/src/sessionFixtures.ts')
    const { historyFingerprint } = await import('/src/sessionCodec.ts')
    const store = new SessionStore(), history = sessionHistory(), sim = sessionSimulation(history)
    const historyId = await historyFingerprint(history)
    await store.cacheHistory(historyId, history)
    await store.save({ id: crypto.randomUUID(), name: 'Older browser backtest', createdAt: new Date().toISOString(), range: { from: history.tradingFrom, to: history.to }, historyId, totalCandles: history.bid.length }, sim.snapshot(), null)
    await store.close()
  })
  await page.route('**/api/storage/status', async route => { await new Promise(resolve => setTimeout(resolve, 350)); await route.continue() })
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByText('Checking saved backtests…', { exact: true }).waitFor()
    assert.equal(await page.getByRole('region', { name: 'Backtest setup' }).isVisible(), false)
    await page.getByRole('button', { name: 'Review browser backtests', exact: true }).waitFor()
    assert.equal(await page.locator('dialog').count(), 0)
    assert.equal(await page.getByRole('button', { name: 'Load historical data', exact: true }).isEnabled(), true)
    assert.equal(await page.getByRole('region', { name: 'Backtest setup' }).isVisible(), true)
  }
  for (const [width, height] of [[1440, 900], [1100, 800]]) {
    await page.setViewportSize({ width, height })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width)
    await page.screenshot({ path: `docs/task-20/startup-legacy-${width}.png`, fullPage: true })
  }
  await page.getByRole('button', { name: 'Review browser backtests', exact: true }).click()
  await page.getByRole('button', { name: 'Import to disk', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Close management', exact: true }).click()
  assert.equal(await page.locator('dialog').count(), 0)
  await page.getByRole('button', { name: 'Review browser backtests', exact: true }).click()
  await page.getByRole('button', { name: 'Import to disk', exact: true }).click()
  await page.getByRole('button', { name: 'Resume / Manage sessions', exact: true }).click()
  await page.getByRole('button', { name: 'Resume session', exact: true }).waitFor()
  assert.deepEqual(errors, []); assert.deepEqual(historyRequests, [])
  await writeFile('docs/task-20/startup-verification.json', JSON.stringify({ errors, historyRequests, verified: ['delayed discovery hides Setup', 'legacy-only refresh keeps Setup available', 'two reloads', 'optional dismissible migration', 'original browser session imports successfully', 'desktop/laptop no overflow'] }, null, 2))
} finally {
  await browser.close(); await vite.close(); await new Promise<void>(resolve => api.close(() => resolve()))
  await rm(directory, { recursive: true, force: true })
}
