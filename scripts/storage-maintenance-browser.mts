// Actual Chromium + local backend; deterministic offline provider, isolated storage/cache.
import { chromium } from 'playwright-core'
import { createServer } from 'vite'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile, readFile, readdir, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import type { SessionRecord } from '../frontend/src/sessionTypes.ts'

const directory = await mkdtemp(join(tmpdir(), 'forextester-browser-'))
const mode = join(directory, 'provider-mode'), cache = join(directory, 'provider-cache'), data = join(directory, 'sessions-data')
await writeFile(mode, 'matching')
const vite = await createServer({ configFile: false, root: join(process.cwd(), 'frontend'), server: { host: '127.0.0.1', port: 5187, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:3017', changeOrigin: false } } } })
const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/durable-storage-browser-server.mts'], { env: { ...process.env, FOREXTESTER_DATA_DIR: data, FOREXTESTER_CACHE_DIR: cache, FOREXTESTER_BROWSER_PROVIDER_MODE_FILE: mode }, stdio: ['ignore', 'pipe', 'pipe'] })
const backendReady = new Promise<void>((resolve, reject) => { child.stdout!.once('data', () => resolve()); child.once('exit', (c) => reject(new Error(`Backend exited ${c}`))); child.stderr!.on('data', (d) => process.stderr.write(d)) })
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? '/home/admin/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell' })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
const page = await context.newPage(), errors: string[] = [], results: Record<string, unknown> = {}
page.on('pageerror', (e) => errors.push(e.message)); page.on('dialog', (d) => d.accept())
async function saved() {
  const name = await page.getByLabel('Current session name').inputValue()
  const cursor = Number((await page.getByLabel('Replay progress', { exact: true }).textContent())!.split('/')[0].trim())
  await page.getByRole('button', { name: 'Save now', exact: true }).click()
  await page.waitForFunction(async ({ name, cursor }) => (await (await fetch('/api/storage/sessions')).json()).sessions.find((r: SessionRecord) => r.name === name)?.checkpoint.executionCursor === cursor, { name, cursor })
  await page.locator('.session-status strong').filter({ hasText: /^Saved$/ }).waitFor()
}
async function current(): Promise<SessionRecord> { const name = await page.getByLabel('Current session name').inputValue(); return page.evaluate(async (name) => (await (await fetch('/api/storage/sessions')).json()).sessions.find((r: SessionRecord) => r.name === name), name) }
async function choose(name: string) { await page.locator('.saved-session').filter({ hasText: name }).getByRole('button', { name: 'Resume session', exact: true }).click() }
async function restored(name: string) {
  await page.waitForFunction((name) => { const field = document.querySelector<HTMLFieldSetElement>('.workspace-controls'); return document.querySelector<HTMLInputElement>('[aria-label="Current session name"]')?.value === name && field && !field.disabled && !field.hidden }, name)
  assert.equal(await page.getByLabel('Replay status', { exact: true }).textContent(), 'Paused')
}
async function maintenance() { await page.locator('details').filter({ has: page.getByText('Storage maintenance', { exact: true }) }).locator('summary').click() }
try {
  await backendReady; await vite.listen(); await page.goto('http://127.0.0.1:5187')
  await page.getByRole('button', { name: 'Start Replay', exact: true }).waitFor()
  await page.getByLabel('Current session name').fill('Maintenance browser A')
  await page.getByLabel('Reference balance (USD)', { exact: true }).fill('10000')
  await page.getByLabel('Maximum combined gross planned risk (%)', { exact: true }).fill('20')
  await page.getByLabel('Round-trip commission (USD per standard lot)', { exact: true }).fill('7')
  await page.getByRole('button', { name: 'Start Replay', exact: true }).click()
  await page.getByLabel('Sizing mode', { exact: true }).selectOption('manual')
  await page.getByLabel('Volume (lots)', { exact: true }).fill('0.1')
  await page.getByLabel('SL price', { exact: true }).fill('1.098')
  await page.getByRole('button', { name: 'Buy', exact: true }).click()
  await page.getByRole('button', { name: 'Buy', exact: true }).click()
  await page.getByRole('button', { name: 'Next Candle', exact: true }).click()
  await saved()
  assert.equal((await current()).checkpoint.trading.positions.length, 2)
  await page.locator('input[aria-label^="Replacement SL "]').first().fill('1.0997')
  await page.locator('button[aria-label^="Update SL "]').first().click()
  await page.getByRole('button', { name: 'Next Candle', exact: true }).click(); await saved()
  let record = await current()
  assert.equal(record.checkpoint.trading.closed[0].exitReason, 'stop_loss')
  await page.locator('button[aria-label^="Close position "]').first().click()
  await page.getByRole('button', { name: 'Next Candle', exact: true }).click(); await saved()
  record = await current(); assert.equal(record.checkpoint.trading.closed[1].exitReason, 'manual')
  const expectedCursor = record.checkpoint.executionCursor + 1
  await page.getByRole('button', { name: 'Next Candle', exact: true }).click()
  await page.waitForFunction(async (cursor) => (await (await fetch('/api/storage/sessions')).json()).sessions.find((r: SessionRecord) => r.name === 'Maintenance browser A').checkpoint.executionCursor === cursor, expectedCursor)
  const baseline = await current()
  const downloadWait = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export Journal CSV', exact: true }).click()
  const download = await downloadWait; const downloadPath = await download.path(); const csv = await readFile(downloadPath!, 'utf8')
  assert.ok(csv.includes('stop_loss') && csv.includes('manual')); results.regressionTrading = { manualEntry: true, automaticStopLoss: true, manualClose: true, saveNow: true, autosave: true, csvRows: csv.split('\r\n').length }

  // A: missing history, explicit repair, exact checkpoint/financial state preserved.
  const historyFile = join(data, 'history', `${baseline.historyId}.json.gz`)
  await rm(historyFile); await page.reload(); await choose('Maintenance browser A')
  await page.getByRole('button', { name: 'Repair historical data', exact: true }).waitFor()
  assert.ok((await page.locator('.session-controls').textContent())!.includes('missing'))
  await page.screenshot({ path: '/tmp/task18-repair.png', fullPage: true })
  await page.getByRole('button', { name: 'Repair historical data', exact: true }).click(); await restored('Maintenance browser A')
  await saved(); const repaired = await current()
  assert.deepEqual(repaired.checkpoint, baseline.checkpoint)
  assert.deepEqual(repaired.chunkHashes, baseline.chunkHashes)
  results.repairMissing = 'Restored paused; checkpoint, trades, commissions, cursor, equity summary and chunk hashes identical'

  // B: corrupt history + different provider prices cannot replace available files.
  await writeFile(historyFile, 'original damaged history'); await writeFile(mode, 'changed')
  await page.reload(); await choose('Maintenance browser A'); await page.getByRole('button', { name: 'Repair historical data', exact: true }).waitFor()
  assert.ok((await page.locator('.session-controls').textContent())!.includes('corrupted'))
  await page.getByRole('button', { name: 'Repair historical data', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'different historical data' }).waitFor()
  assert.equal(await readFile(historyFile, 'utf8'), 'original damaged history')
  const unchanged = await page.evaluate(async (id) => (await (await fetch(`/api/storage/sessions/${id}`)).json()).record, baseline.id)
  assert.deepEqual(unchanged.checkpoint, baseline.checkpoint)
  await page.screenshot({ path: '/tmp/task18-mismatch.png', fullPage: true })
  results.fingerprintMismatch = 'Changed prices rejected; damaged history bytes and saved trading/equity/cursor preserved'
  await writeFile(mode, 'matching'); await page.getByRole('button', { name: 'Repair historical data', exact: true }).click(); await restored('Maintenance browser A')
  await saved(); assert.deepEqual((await current()).checkpoint, baseline.checkpoint); results.repairCorrupt = 'Explicit retry with identical data restored paused'

  // C: another session shares history; delete first, preview and sweep only aged obsolete objects.
  await page.getByRole('button', { name: 'New session', exact: true }).click(); await page.getByRole('button', { name: 'Start Replay', exact: true }).waitFor()
  await page.getByLabel('Current session name').fill('Maintenance browser B'); await saved()
  const surviving = await current(); assert.equal(surviving.historyId, baseline.historyId)
  await page.getByRole('button', { name: 'Resume / Manage sessions', exact: true }).click()
  await page.locator('.saved-session').filter({ hasText: 'Maintenance browser A' }).getByRole('button', { name: 'Delete', exact: true }).click()
  await page.locator('.saved-session').filter({ hasText: 'Maintenance browser A' }).waitFor({ state: 'detached' })
  const extra = join(data, 'checkpoints', `${'f'.repeat(64)}.json`); await writeFile(extra, Buffer.alloc(1234)); const age = new Date(Date.now() - 8 * 86_400_000)
  for (const folder of ['checkpoints', 'equity', 'history']) for (const name of await readdir(join(data, folder))) await utimes(join(data, folder, name), age, age)
  await maintenance(); await page.getByRole('button', { name: 'Preview cleanup', exact: true }).click(); await page.getByRole('button', { name: 'Clean up unused files', exact: true }).waitFor()
  const preview = await page.evaluate(async () => (await fetch('/api/storage/cleanup')).json())
  assert.equal(preview.safe, true); assert.ok(preview.candidateFiles > 0)
  assert.equal((await readFile(extra)).length, 1234)
  await page.getByRole('button', { name: 'Clean up unused files', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Reclaimed' }).waitFor()
  await assert.rejects(readFile(extra)); assert.ok((await readFile(historyFile)).length > 0)
  const afterPreview = await page.evaluate(async () => (await fetch('/api/storage/cleanup')).json()); assert.equal(afterPreview.candidateFiles, 0)
  const deletedResponse = await page.evaluate(async (id) => (await fetch(`/api/storage/sessions/${id}`)).status, baseline.id); assert.equal(deletedResponse, 404)
  results.cleanup = { eligibleFiles: preview.candidateFiles, reclaimedBytes: preview.reclaimableBytes, sharedHistoryRetained: true, deletedSessionStatus: deletedResponse }
  await page.reload(); await choose('Maintenance browser B')
  await page.waitForFunction(() => { const f = document.querySelector<HTMLFieldSetElement>('.workspace-controls'); return f && !f.disabled && !f.hidden })
  assert.deepEqual((await current()).checkpoint, surviving.checkpoint); await saved()
  results.regressionRecovery = 'Surviving session restored after cleanup and browser refresh; later save succeeded'
  // Desktop/mobile verification on the compact controls in their real page context.
  await maintenance(); await page.getByRole('button', { name: 'Preview cleanup', exact: true }).click()
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 }); await page.waitForTimeout(200)
    const dimensions = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))
    assert.ok(dimensions.document <= width, JSON.stringify(dimensions))
    await page.screenshot({ path: `/tmp/task18-${width}.png`, fullPage: true }); results[`viewport${width}`] = dimensions
  }
  assert.deepEqual(errors, []); results.browserExceptions = errors
  await writeFile('/tmp/task18-browser-results.json', JSON.stringify(results, null, 2)); console.log(JSON.stringify(results, null, 2))
} catch (error) {
  console.error('UI:', await page.locator('.session-controls').textContent().catch(() => 'unavailable'))
  throw error
} finally {
  await browser.close(); await vite.close()
  if (child.exitCode === null) { const stopped = new Promise<void>((r) => child.once('exit', () => r())); child.kill('SIGKILL'); await stopped }
  await rm(directory, { recursive: true, force: true })
}
