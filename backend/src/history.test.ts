import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
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
  const fresh = await service.estimate('2024-01-09', '2024-01-11')
  await writeFile(join(root, 'download.lock'), 'manual fixture')
  await expect(service.confirm(fresh.id, true)).rejects.toMatchObject({ code: 'DOWNLOAD_BUSY' })
  await rm(join(root, 'download.lock')); client.estimateUsd = .02
  await service.confirm((await service.estimate('2024-01-09', '2024-01-11')).id, true)
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

it('loads and quotes cached dates without metadata, credentials, credit evidence, approval or ledger changes', async () => {
  const history = await service.confirm((await service.estimate('2024-01-09', '2024-01-11')).id, true)
  if (!('candles' in history)) throw Error('Expected single-price history')
  const ledger = await readFile(join(root, 'verification-budget.json'), 'utf8')
  const offline = new FixtureDatabento()
  offline.availability = offline.cost = offline.contracts = async () => { throw Error('No metadata permitted') }
  const restarted = new HistoryService(offline, root, { DATABENTO_TEST_BUDGET_USD: '0' }, fixtureNow)
  expect(await restarted.cachedBounds()).toEqual({ from: history.from, to: history.to, cachedDates: 32 })
  expect(await restarted.estimate('2024-01-09', '2024-01-11')).toMatchObject({ cached: true, estimatedUsd: 0, reservedUsd: 0, downloadAllowed: true, blockedReason: null })
  expect((await restarted.readCached(history.from, history.to)).candles).toEqual(history.candles)
  expect(await readFile(join(root, 'verification-budget.json'), 'utf8')).toBe(ledger)
  expect(offline.paid).toHaveLength(0)
})

it('quotes only separated missing intervals, keeps successful days after a later failure, and reuses them on restart', async () => {
  await service.confirm((await service.estimate('2024-01-09', '2024-01-11', 0)).id, true)
  const quote = await service.estimate('2024-01-09', '2024-01-12')
  expect(quote.missingRanges).toEqual([{ from: '2023-12-10', to: '2024-01-09' }, { from: '2024-01-11', to: '2024-01-12' }])
  expect(quote.estimatedUsd).toBe(.04)
  const download = client.download.bind(client)
  client.download = async (...args) => { if (args[0] === '2024-01-11') client.failDownload = true; return download(...args) }
  await expect(service.confirm(quote.id, true)).rejects.toThrow('Fixture interruption')
  expect((await service.readCached('2023-12-10', '2024-01-11')).candles.length).toBeGreaterThan(0)
  const restarted = new HistoryService(client, root, creditEnv, fixtureNow)
  expect((await restarted.estimate('2024-01-09', '2024-01-12')).missingRanges).toEqual([{ from: '2024-01-11', to: '2024-01-12' }])
  const ledger = JSON.parse(await readFile(join(root, 'verification-budget.json'), 'utf8'))
  expect(ledger.reservations.map((r: { state: string }) => r.state)).toEqual(['complete', 'reserved'])
  expect(ledger.reservations.reduce((sum: number, r: { reservedUsd: number }) => sum + r.reservedUsd, 0)).toBeCloseTo(.12)
})

it('invalidates every submission after a price/credit failure and after expiry during metadata revalidation', async () => {
  let now = fixtureNow()
  const env = { ...creditEnv }
  const guarded = new HistoryService(client, root, env, () => now)
  const quote = await guarded.estimate('2024-01-09', '2024-01-11')
  env.DATABENTO_CREDITS_USD = '0'
  await expect(guarded.confirm(quote.id, true)).rejects.toMatchObject({ code: 'SPENDING_BLOCKED' })
  env.DATABENTO_CREDITS_USD = '121.35'
  await expect(guarded.confirm(quote.id, true)).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' })
  const next = await guarded.estimate('2024-01-09', '2024-01-11')
  client.cost = async () => { now = new Date(now.getTime() + 5 * 60000); return .02 }
  await expect(guarded.confirm(next.id, true)).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' })
  expect(client.paid).toHaveLength(0)
  await expect(readFile(join(root, 'verification-budget.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('serializes separate services, rejects restart quotes and retains uncertain reservations and crash locks', async () => {
  const second = new HistoryService(client, root, creditEnv, fixtureNow)
  const firstQuote = await service.estimate('2024-01-09', '2024-01-11'), secondQuote = await second.estimate('2024-01-09', '2024-01-11')
  const results = await Promise.allSettled([service.confirm(firstQuote.id, true), second.confirm(secondQuote.id, true)])
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  expect(client.paid).toHaveLength(1)
  const restarted = new HistoryService(client, root, creditEnv, fixtureNow)
  await expect(restarted.confirm(secondQuote.id, true)).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' })
  await writeFile(join(root, 'download.lock'), 'crashed backend')
  const quote = await restarted.estimate('2024-02-01', '2024-02-02')
  await expect(restarted.confirm(quote.id, true)).rejects.toMatchObject({ code: 'DOWNLOAD_BUSY' })
  expect(client.paid).toHaveLength(1)
  expect((await restarted.estimate('2024-01-09', '2024-01-11')).cached).toBe(true)
})

it('invalidates approval when cached observations change even if missing ranges stay the same', async () => {
  await service.confirm((await service.estimate('2024-01-09', '2024-01-10', 0)).id, true)
  const quote = await service.estimate('2024-01-09', '2024-01-11', 0)
  expect(quote.missingRanges).toEqual([{ from: '2024-01-10', to: '2024-01-11' }])
  const ref = JSON.parse(await readFile(join(root, '2024-01-09.ref.json'), 'utf8'))
  const file = join(root, `${ref.id}.json`), envelope = JSON.parse(await readFile(file, 'utf8'))
  envelope.history.candles[0].close += .00001
  envelope.digest = createHash('sha256').update(JSON.stringify(envelope.history)).digest('hex')
  await writeFile(file, JSON.stringify(envelope))
  await expect(service.confirm(quote.id, true)).rejects.toMatchObject({ code: 'QUOTE_CHANGED' })
  expect(client.paid).toHaveLength(1)
})
