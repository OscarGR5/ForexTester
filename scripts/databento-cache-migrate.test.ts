import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateCache } from './databento-cache-migrate.mts'
import { HistoryService } from '../backend/src/history.js'
import { FixtureDatabento, creditEnv, fixtureNow } from '../tests/databentoFixture.js'
let root: string, source: string, destination: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cache-import-test-')); source = join(root, 'source'); destination = join(root, 'destination')
  await mkdir(source)
  const service = new HistoryService(new FixtureDatabento(), source, creditEnv, fixtureNow)
  await service.confirm((await service.estimate('2024-01-09', '2024-01-11', 0)).id, true)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
it('copies validated cache and complete ledger byte for byte, keeps source intact and reruns without overwriting', async () => {
  const names = (await readdir(source)).sort(), before = await Promise.all(names.map(name => readFile(join(source, name), 'utf8')))
  const imported = await migrateCache(source, destination)
  expect(imported.dates).toBe(2)
  expect((await readdir(destination)).sort()).toEqual(names)
  expect(await Promise.all(names.map(name => readFile(join(destination, name), 'utf8')))).toEqual(before)
  expect(await migrateCache(source, destination)).toEqual(imported)
  expect(await Promise.all(names.map(name => readFile(join(source, name), 'utf8')))).toEqual(before)
})
it.each(['verification-budget.json', '2024-01-09.ref.json'])('stops before copying on conflicting %s, preserving both originals', async name => {
  await mkdir(destination); await writeFile(join(destination, name), 'existing conflicting data')
  await expect(migrateCache(source, destination)).rejects.toThrow('Destination conflict')
  expect(await readFile(join(destination, name), 'utf8')).toBe('existing conflicting data')
  expect(await readdir(destination)).toEqual([name])
  expect(await readFile(join(source, name), 'utf8')).not.toBe('existing conflicting data')
})
it('refuses verification sessions and corrupt data before publishing any files', async () => {
  await writeFile(join(source, 'sessions.json'), 'test sessions')
  await expect(migrateCache(source, destination)).rejects.toThrow('Unexpected source file')
  await rm(join(source, 'sessions.json'))
  const ref = JSON.parse(await readFile(join(source, '2024-01-09.ref.json'), 'utf8'))
  await writeFile(join(source, `${ref.id}.json`), '{}')
  await expect(migrateCache(source, destination)).rejects.toMatchObject({ code: 'CACHE_CORRUPT' })
  expect(await readdir(destination)).toEqual([])
})
it('retains crash locks and does not import while either cache is in use', async () => {
  await writeFile(join(source, 'download.lock'), 'uncertain paid request')
  await expect(migrateCache(source, destination)).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readFile(join(source, 'download.lock'), 'utf8')).toBe('uncertain paid request')
  expect(await readdir(destination)).toEqual([])
})
