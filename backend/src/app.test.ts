import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { createApp } from './app.js'
import { HistoryService } from './history.js'
import { SessionStorage } from './sessionStorage.js'
import { DatabentoClient } from './databento.js'
import { creditEnv, fixtureNow, FixtureDatabento } from '../../tests/databentoFixture.js'
let directory: string, server: Server, origin: string, client: FixtureDatabento
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'databento-api-'))
  const { mkdir } = await import('node:fs/promises'); await mkdir(join(directory, 'cache'))
  client = new FixtureDatabento()
  server = createApp(new HistoryService(client, join(directory, 'cache'), creditEnv, fixtureNow), fixtureNow, new SessionStorage({ directory: join(directory, 'sessions') }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(async () => { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }); await rm(directory, { recursive: true, force: true }) })
it('exposes metadata and a free exact quote; GET history is cache-only and legacy requests cannot substitute data', async () => {
  expect((await fetch(`${origin}/api/history/coverage`)).status).toBe(200)
  expect((await fetch(`${origin}/api/history?symbol=6E&from=2024-01-09&to=2024-01-11`)).status).toBe(409)
  const legacy = await fetch(`${origin}/api/history?symbol=EURUSD&from=2024-01-09&to=2024-01-11`)
  expect(await legacy.json()).toMatchObject({ code: 'LEGACY_DATASET_REQUIRED' })
  const quote = await (await fetch(`${origin}/api/history/estimate?symbol=6E&from=2024-01-09&to=2024-01-11`)).json()
  expect(quote).toMatchObject({ estimatedUsd: .02, cached: false }); expect(client.paid).toHaveLength(0)
  const result = await fetch(`${origin}/api/history/download`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ quoteId: quote.id, confirm: true }) })
  expect(result.status).toBe(200); expect((await result.json()).priceModel).toBe('single'); expect(client.paid).toHaveLength(1)
})
it('requires same-origin protection and explicit confirmation before spending', async () => {
  const quote = await (await fetch(`${origin}/api/history/estimate?symbol=6E&from=2024-01-09&to=2024-01-11`)).json()
  for (const headers of [{}, { Origin: 'https://untrusted.example' }] as Record<string, string>[]) {
    expect((await fetch(`${origin}/api/history/download`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ quoteId: quote.id, confirm: true }) })).status).toBe(403)
  }
  const result = await fetch(`${origin}/api/history/download`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ quoteId: quote.id }) })
  expect(result.status).toBe(400); expect(client.paid).toHaveLength(0)
})
it('reports missing key without exposing credentials or making a request', async () => {
  const client = new DatabentoClient('')
  await expect(client.availability()).rejects.toMatchObject({ code: 'DATABENTO_CONFIGURATION' })
})
it.each(['from=2024-02-30&to=2024-03-01', 'from=2024-01-01&to=2024-04-01', 'from=2024-04-01&to=2024-04-02'])('rejects invalid selection %s', async range => {
  expect((await fetch(`${origin}/api/history/estimate?symbol=6E&${range}`)).status).toBe(400)
  expect(client.paid).toHaveLength(0)
})

it('discovers validated local coverage without live metadata and keeps offline cache loads free', async () => {
  const first = await (await fetch(`${origin}/api/history/estimate?symbol=6E&from=2024-01-09&to=2024-01-11`)).json()
  await fetch(`${origin}/api/history/download`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ quoteId: first.id, confirm: true }) })
  client.availability = async () => { throw Error('Offline') }
  const count = client.metadataCalls.length
  expect(await (await fetch(`${origin}/api/history/coverage`)).json()).toMatchObject({ cachedFrom: '2023-12-10', cachedTo: '2024-01-11', providerEarliestTimestamp: null, earliestSelectableDate: null, providerHealth: { status: 'cache-validated' } })
  const quote = await (await fetch(`${origin}/api/history/estimate?symbol=6E&from=2024-01-09&to=2024-01-11`)).json()
  expect(quote).toMatchObject({ cached: true, estimatedUsd: 0 })
  expect((await fetch(`${origin}/api/history?symbol=6E&from=2023-12-10&to=2024-01-11`)).status).toBe(200)
  expect(client.metadataCalls).toHaveLength(count)
  expect(client.paid).toHaveLength(1)
})

it('quotes earlier uncached dates through verified metadata without spending, while cached dates stay free offline', async () => {
  const initial = await (await fetch(`${origin}/api/history/estimate?symbol=6E&from=2024-01-09&to=2024-01-11`)).json()
  await fetch(`${origin}/api/history/download`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ quoteId: initial.id, confirm: true }) })
  const ledgerPath = join(directory, 'cache', 'verification-budget.json'), ledger = await readFile(ledgerPath, 'utf8'), paid = client.paid.length
  const coverage = await (await fetch(`${origin}/api/history/coverage`)).json()
  expect(coverage).toMatchObject({ cachedFrom: '2023-12-10', providerEarliestTimestamp: null, earliestSelectableDate: null })
  client.metadataCalls.length = 0
  const response = await fetch(`${origin}/api/history/estimate?symbol=6E&from=2022-01-03&to=2022-01-05`)
  expect(response.status).toBe(200)
  const quote = await response.json()
  expect(quote).toMatchObject({ tradingFrom: '2022-01-03', cached: false, downloadAllowed: true, estimatedUsd: .02, missingRanges: [{ from: '2021-12-04', to: '2022-01-05' }] })
  expect(client.metadataCalls).toEqual(['availability', 'contracts', 'cost'])
  const unapproved = await fetch(`${origin}/api/history/download`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ quoteId: quote.id, confirm: false }) })
  expect(await unapproved.json()).toMatchObject({ code: 'DOWNLOAD_CONFIRMATION_REQUIRED' })
  client.availability = () => new DatabentoClient('').availability()
  const blocked = await fetch(`${origin}/api/history/estimate?symbol=6E&from=2022-01-03&to=2022-01-05`)
  expect(blocked.status).toBe(503)
  expect(await blocked.json()).toMatchObject({ code: 'DATABENTO_CONFIGURATION' })
  const free = await (await fetch(`${origin}/api/history/estimate?symbol=6E&from=2024-01-09&to=2024-01-11`)).json()
  expect(free).toMatchObject({ cached: true, estimatedUsd: 0, reservedUsd: 0, downloadAllowed: true })
  expect(client.paid).toHaveLength(paid)
  expect(await readFile(ledgerPath, 'utf8')).toBe(ledger)
})
