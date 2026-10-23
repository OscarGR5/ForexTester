import assert from 'node:assert/strict'
import type { Page } from 'playwright-core'
import { benchmarkHistory } from './chart-replay-data'
import { journalCsv } from '../frontend/src/journalCsv'
import { recordEquity } from '../frontend/src/equity'
import { restoreEquity } from '../frontend/src/sessionCodec'
import { equityObservations } from '../frontend/src/equityDisplay'
import { equitySummary, type SessionRecord } from '../frontend/src/sessionTypes'
import { modifyStop, observeCandle, requestClose, requestEntry, updateSetupMetadata } from '../frontend/src/trading'
import { manualPermission } from '../frontend/src/sessionFixtures'

export async function verifyReplayWorkspace(page: Page) {
  page.on('dialog', dialog => dialog.accept())
  const name = await page.getByLabel('Current session name').inputValue()
  const progress = async () => Number((await page.locator('[aria-label="Replay progress"]').textContent())!.split('/')[0])
  const read = () => page.evaluate(async name => {
    const { sessions } = await (await fetch('/api/storage/sessions')).json()
    const record = sessions.find((r: SessionRecord) => r.name === name)
    return (await (await fetch(`/api/storage/sessions/${record.id}`)).json()) as { record: SessionRecord; chunks: { points: import('../frontend/src/equity').EquityPoint[] }[] }
  }, name)
  async function save() {
    const count = await progress()
    await page.getByRole('button', { name: 'Save now', exact: true }).click()
    await page.waitForFunction(async ({ name, count }) => {
      const { sessions } = await (await fetch('/api/storage/sessions')).json()
      const record = sessions.find((r: SessionRecord) => r.name === name)
      return record?.checkpoint.equity.count === count && document.querySelector('.session-status strong')?.textContent === 'Saved'
    }, { name, count })
    return read()
  }
  const initial = await save(), history = benchmarkHistory(90)
  let state = initial.record.checkpoint.trading, cursor = initial.record.checkpoint.executionCursor
  let ledger = restoreEquity(initial.chunks.flatMap(c => c.points), initial.record.checkpoint.equity, state.account.referenceBalance)
  function observeTo(next: number) {
    for (; cursor < next; cursor++) {
      const previous = state; state = observeCandle(state, history.bid[cursor], history.ask[cursor]); ledger = recordEquity(ledger, previous, state)
    }
  }
  async function equivalent() {
    const saved = await save(); observeTo(saved.record.checkpoint.executionCursor)
    assert.deepEqual(saved.record.checkpoint.trading, state)
    assert.deepEqual(saved.record.checkpoint.equity, equitySummary(ledger))
    assert.deepEqual(saved.chunks.flatMap(c => c.points), equityObservations(ledger))
    const latest = await page.evaluate(() => globalThis.__forexReplayPerformance?.latest)
    for (let id = 0; id < 3; id++) assert.equal(latest?.[`chart.${id}.cursor`], cursor)
    return saved
  }
  await page.getByLabel('Sizing mode', { exact: true }).selectOption('manual')
  const stop = Number((state.quote!.bid!.close - .003).toFixed(5))
  for (const lots of [.1, .2]) {
    await page.getByLabel('Volume (lots)', { exact: true }).fill(String(lots))
    await page.getByLabel('SL price', { exact: true }).fill(String(stop))
    await page.getByRole('button', { name: 'Buy', exact: true }).click()
    state = requestEntry(state, 'buy', lots, stop, manualPermission)
  }
  await page.getByRole('button', { name: 'Next Candle', exact: true }).click()
  const filled = await equivalent(); assert.equal(state.positions.length, 2)
  for (const [index, position] of state.positions.entries()) {
    const replacement = Number((state.quote!.bid!.close - (index ? .0025 : .00005)).toFixed(5))
    await page.getByLabel(`Replacement SL ${position.id}`, { exact: true }).fill(String(replacement))
    await page.getByRole('button', { name: `Update SL ${position.id}`, exact: true }).click()
    state = modifyStop(state, position.id, replacement, manualPermission)
  }
  const before = await progress()
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: 'Buy', exact: true }).isDisabled(), true)
  await page.waitForFunction(min => Number(document.querySelector('[aria-label="Replay progress"]')!.textContent!.split('/')[0]) >= min, before + 300)
  // Exercise data rebuilds and interaction while the financial clock keeps running.
  for (const timeframe of ['M1', 'M5']) await page.getByLabel('Chart 1 timeframe', { exact: true }).selectOption(timeframe)
  await page.locator('input[name="chart-count"][value="2"]').check()
  await page.locator('input[name="chart-count"][value="3"]').check()
  const canvas = await page.locator('.chart-canvas').first().boundingBox(); assert.ok(canvas)
  await page.mouse.move(canvas.x + 200, canvas.y + 60)
  await page.mouse.wheel(0, -120)
  await page.mouse.down(); await page.mouse.move(canvas.x + 260, canvas.y + 60); await page.mouse.up()
  await page.locator('.chart-pane').first().locator('summary').click()
  await page.getByLabel('Chart 1 BB #1 Length', { exact: true }).fill('21')
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await equivalent()
  assert.equal(state.closed.length, 1); assert.equal(state.closed[0].exitReason, 'stop_loss'); assert.equal(state.positions.length, 1)
  const remaining = state.positions[0]
  await page.getByRole('button', { name: `Close position ${remaining.id}`, exact: true }).click()
  state = requestClose(state, remaining.id, manualPermission)
  await page.getByRole('button', { name: 'Next Candle', exact: true }).click()
  await equivalent(); assert.equal(state.closed.length, 2); assert.equal(state.closed[1].exitReason, 'manual')
  const setup = state.setups[0]
  await page.locator('button[aria-label^="Details for setup "]').first().click()
  await page.getByLabel(`Setup notes ${setup.id}`, { exact: true }).fill('Task 19 deterministic browser verification')
  state = updateSetupMetadata(state, setup.id, { ...setup, notes: 'Task 19 deterministic browser verification' })
  const saved = await equivalent()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export Journal CSV', exact: true }).click()
  const download = await downloadPromise
  const stream = await download.createReadStream(); assert.ok(stream)
  let csv = ''; for await (const chunk of stream) csv += chunk.toString()
  assert.equal(csv, journalCsv(state))
  assert.ok(csv.includes('stop_loss') && csv.includes('manual') && csv.includes('Task 19 deterministic browser verification'))
  await page.reload()
  await page.locator('.saved-session').filter({ has: page.locator('.saved-session-info strong').filter({ hasText: new RegExp(`^${name}$`) }) }).getByRole('button', { name: 'Resume session', exact: true }).click()
  await page.waitForFunction(() => { const f = document.querySelector<HTMLFieldSetElement>('.workspace-controls'); return f && !f.disabled && !f.hidden })
  assert.equal(await page.locator('[aria-label="Replay status"]').textContent(), 'Paused')
  assert.equal(await page.getByLabel('Chart 1 BB #1 Length', { exact: true }).inputValue(), '21')
  await equivalent()
  await page.getByRole('button', { name: 'Next Candle', exact: true }).click(); await equivalent()
  assert.equal(state.closed.length, 2)
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.screenshot({ path: `/tmp/task19-verified-${width}.png`, fullPage: true })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width)
    assert.equal(await page.locator('.tv-lightweight-charts').count(), 3)
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('button', { name: 'Restart', exact: true }).click()
  assert.equal(await progress(), 1)
  const reset = await save(); assert.equal(reset.record.checkpoint.trading.closed.length, 0); assert.equal(reset.record.checkpoint.equity.count, 1)
  return { fills: filled.record.checkpoint.trading.positions.map(p => ({ price: p.entryPrice, lots: p.lots, commission: p.entryCommissionUsd })),
    exits: saved.record.checkpoint.trading.closed.map(p => ({ price: p.exitPrice, reason: p.exitReason, gross: p.grossPnlUsd, net: p.netPnlUsd, commission: p.totalCommissionUsd, r: p.netPnlUsd / p.initialRiskUsd })),
    cursor: saved.record.checkpoint.executionCursor, equity: saved.record.checkpoint.equity, restoredWithoutDuplicates: true, csvVerified: true, restarted: true }
}
