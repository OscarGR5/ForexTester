import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HistoryService } from './history.js'
import { creditEnv, fixtureNow, FixtureDatabento } from '../../tests/databentoFixture.js'
let root: string, client: FixtureDatabento, service: HistoryService
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'databento-test-')); client = new FixtureDatabento(); service = new HistoryService(client, root, creditEnv, fixtureNow) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
it('quotes exact uncached dates with pre-roll, confirms once, persists validated days and restores offline', async () => {
  const quote = await service.estimate('2024-01-09', '2024-01-11')
  expect(quote).toMatchObject({ from: '2023-12-10', estimatedUsd: .02, reservedUsd: .04, cached: false, downloadAllowed: true })
  expect(client.paid).toHaveLength(0)
  await expect(service.confirm(quote.id, false)).rejects.toMatchObject({ code: 'DOWNLOAD_CONFIRMATION_REQUIRED' })
  const history = await service.confirm(quote.id, true)
  expect(history).toMatchObject({ symbol: '6E', priceModel: 'single', tradingFrom: '2024-01-09' })
  expect('bid' in history || 'ask' in history).toBe(false)
  expect(client.paid).toEqual([{ from: '2023-12-10', to: '2024-01-11' }])
  const restarted = new HistoryService(undefined, root, {}, fixtureNow)
  const { tradingFrom: _, ...stored } = history
  expect(await restarted.readCached(history.from, history.to)).toEqual(stored)
  expect((await restarted.estimate('2024-01-09', '2024-01-11'))).toMatchObject({ cached: true, estimatedUsd: 0, downloadAllowed: true })
})
it('deduplicates overlapping dates, expires consumed quotes, and retains reservations across restarts', async () => {
  const first = await service.estimate('2024-01-09', '2024-01-11'), overlapping = await service.estimate('2024-01-10', '2024-01-12')
  await service.confirm(first.id, true)
  await expect(service.confirm(first.id, true)).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' })
  await expect(service.confirm(overlapping.id, true)).rejects.toMatchObject({ code: 'QUOTE_CHANGED' })
  const next = await service.estimate('2024-01-10', '2024-01-12')
  expect(next.missingRanges).toEqual([{ from: '2024-01-11', to: '2024-01-12' }])
  await service.confirm(next.id, true)
  const ledger = JSON.parse(await readFile(join(root, 'verification-budget.json'), 'utf8'))
  expect(ledger.reservations).toHaveLength(2)
  const restarted = new HistoryService(client, root, creditEnv, fixtureNow)
  expect((await restarted.estimate('2024-02-01', '2024-02-02')).remainingBudgetUsd).toBeCloseTo(4.92)
})
it.each([
  [{}, 'credits are unverified'],
  [{ ...creditEnv, DATABENTO_CREDITS_EXPIRE_AT: '' }, 'expiry is unverified'],
  [{ ...creditEnv, DATABENTO_CREDITS_EXPIRE_AT: '2024-03-31' }, 'expiry is unverified'],
  [{ ...creditEnv, DATABENTO_CREDITS_USD: '0' }, 'credits cannot cover'],
  [{ ...creditEnv, DATABENTO_TEST_BUDGET_USD: '.01' }, 'budget'],
])('blocks paid requests when credit or budget evidence fails', async (env, reason) => {
  const blocked = new HistoryService(client, root, env, fixtureNow), quote = await blocked.estimate('2024-01-09', '2024-01-11')
  expect(quote.downloadAllowed).toBe(false); expect(quote.blockedReason).toContain(reason)
  await expect(blocked.confirm(quote.id, true)).rejects.toMatchObject({ code: 'SPENDING_BLOCKED' })
  expect(client.paid).toHaveLength(0)
})
it('never permits more than $5, invalid costs, silent retries, or budget resets after interrupted downloads', async () => {
  client.estimateUsd = 3
  const quote = await service.estimate('2024-01-09', '2024-01-11')
  expect(quote.downloadAllowed).toBe(false)
  client.estimateUsd = .02; client.failDownload = true
  const next = await service.estimate('2024-01-09', '2024-01-11')
  await expect(service.confirm(next.id, true)).rejects.toThrow('Fixture interruption')
  await expect(service.confirm(next.id, true)).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' })
  expect(client.paid).toHaveLength(1)
  await expect(service.readCached(next.from, next.to)).rejects.toMatchObject({ code: 'HISTORY_NOT_CACHED' })
  expect((await service.estimate('2024-01-09', '2024-01-11')).remainingBudgetUsd).toBeCloseTo(4.96)
})
it('rejects changed prices, corrupt cached objects and a concurrent spending lock without paid work', async () => {
  const quote = await service.estimate('2024-01-09', '2024-01-11')
  client.estimateUsd = .03
  await expect(service.confirm(quote.id, true)).rejects.toMatchObject({ code: 'QUOTE_CHANGED' })
  expect(client.paid).toHaveLength(0)
  await writeFile(join(root, 'download.lock'), 'manual fixture')
  await expect(service.confirm(quote.id, true)).rejects.toMatchObject({ code: 'DOWNLOAD_BUSY' })
  await rm(join(root, 'download.lock')); client.estimateUsd = .02
  await service.confirm(quote.id, true)
  const ref = JSON.parse(await readFile(join(root, '2024-01-09.ref.json'), 'utf8'))
  await writeFile(join(root, `${ref.id}.json`), '{}')
  await expect(service.readCached(quote.from, quote.to)).rejects.toMatchObject({ code: 'CACHE_CORRUPT' })
  expect(client.paid).toHaveLength(1)
})

it('accepts fresh user-confirmed credit validity only for the explicitly approved ranges', async () => {
  const approval = { verifiedAt: fixtureNow().toISOString(), balanceUsd: 121.35, ranges: [{ from: '2023-12-10', to: '2024-01-11' }] }
  const scoped = new HistoryService(client, root, {}, fixtureNow, approval)
  expect((await scoped.estimate('2024-01-09', '2024-01-11')).downloadAllowed).toBe(true)
  expect((await scoped.estimate('2024-02-01', '2024-02-03')).downloadAllowed).toBe(false)
})
