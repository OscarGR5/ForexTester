import { historyCandles } from '../../frontend/src/history.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readdir, readFile, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { request } from 'node:http'
import { gzipSync, gunzipSync } from 'node:zlib'
import { DiskSessionStore } from '../../frontend/src/diskSessionStore.js'
import { SessionStorage, dataDirectory } from './sessionStorage.js'
import { diskApiFixture } from '../../tests/diskApiFixture.js'
import { sessionHistory, sessionSimulation } from '../../frontend/src/sessionFixtures.js'
import { historyFingerprint, recordDigest } from '../../frontend/src/sessionCodec.js'

let api: Awaited<ReturnType<typeof diskApiFixture>>, client: DiskSessionStore
let fail: ((path: string) => Promise<void>) | null
beforeEach(async () => { fail = null; api = await diskApiFixture({ beforePublish: (p) => fail?.(p) ?? Promise.resolve() }); vi.stubGlobal('fetch', api.fetch); client = new DiskSessionStore() })
afterEach(async () => { vi.unstubAllGlobals(); await api.close() })
async function fixture(count = 2200, index = 1024) {
  const sim = sessionSimulation(sessionHistory(count)); sim.observe(index)
  const base = { id: crypto.randomUUID(), name: 'Disk backtest', createdAt: new Date().toISOString(), range: { from: sim.history.tradingFrom, to: sim.history.to }, historyId: await historyFingerprint(sim.history), totalCandles: count }
  await client.cacheHistory(base.historyId, sim.history)
  const saved = await client.save(base, sim.snapshot(), null)
  return { sim, base, saved }
}
describe('durable storage and integrity', () => {
  it('selects XDG/fallback/override paths and rejects repository storage', async () => {
    expect(dataDirectory({}, '/tmp/home')).toBe('/tmp/home/.local/share/forextester')
    expect(dataDirectory({ XDG_DATA_HOME: '/tmp/xdg' }, '/tmp/home')).toBe('/tmp/xdg/forextester')
    expect(dataDirectory({ XDG_DATA_HOME: 'relative' }, '/tmp/home')).toBe('/tmp/home/.local/share/forextester')
    expect(dataDirectory({ FOREXTESTER_DATA_DIR: '/tmp/custom' })).toBe('/tmp/custom')
    expect(() => dataDirectory({ FOREXTESTER_DATA_DIR: process.cwd() })).toThrow('outside')
    expect((await client.status()).directory).toBe(api.directory)
    expect(await readdir(api.directory)).toEqual(expect.arrayContaining(['sessions', 'checkpoints', 'equity', 'history', 'imports']))
  })
  it('creates, restores, renames, deletes and keeps two independent sessions with shared history', async () => {
    const first = await fixture(), second = await fixture()
    expect(await readdir(join(api.directory, 'history'))).toHaveLength(1)
    const restored = await client.recover(first.saved.id)
    expect(restored.checkpoint).toEqual(first.saved.checkpoint)
    expect(restored.ledger.count).toBe(1025)
    const renamed = await client.rename(first.saved.id, 'London', first.saved.revision)
    expect(renamed.name).toBe('London')
    await client.delete(renamed.id, renamed.revision)
    await expect(client.recover(renamed.id)).rejects.toThrow('not found')
    expect((await client.recover(second.saved.id)).checkpoint).toEqual(second.saved.checkpoint)
    await expect(client.save(first.base, first.sim.snapshot(), first.saved)).rejects.toThrow('changed')
    await expect(client.save(first.base, first.sim.snapshot(), null)).rejects.toThrow('changed')
  })
  it('publishes immutable data before the manifest and changes only the equity suffix', async () => {
    const { sim, base, saved } = await fixture()
    const paths: string[] = []; fail = async (path) => { paths.push(path) }
    const old = await readdir(join(api.directory, 'equity')), firstStat = await stat(join(api.directory, 'equity', `${saved.chunkHashes[0]}.json.gz`))
    sim.observe(1030)
    const next = await client.save(base, sim.snapshot(), saved)
    expect(next.chunkHashes[0]).toBe(saved.chunkHashes[0]); expect(next.chunkHashes[1]).not.toBe(saved.chunkHashes[1])
    expect((await readdir(join(api.directory, 'equity'))).length).toBe(old.length + 1)
    expect((await stat(join(api.directory, 'equity', `${saved.chunkHashes[0]}.json.gz`))).mtimeMs).toBe(firstStat.mtimeMs)
    expect(paths.at(-1)).toBe(join(api.directory, 'sessions', `${saved.id}.json`))
    paths.length = 0
    await client.save(base, sim.snapshot(), next)
    expect(paths.some((path) => path.includes('/equity/') || path.includes('/history/'))).toBe(false)
  })
  it.each(['equity', 'checkpoints', 'sessions'])('keeps the previous committed snapshot after interruption before %s publication', async (folder) => {
    const { sim, base, saved } = await fixture(); sim.observe(1030)
    fail = async (path) => { if (path.includes(`/${folder}/`)) throw new Error('interrupted') }
    await expect(client.save(base, sim.snapshot(), saved)).rejects.toThrow()
    expect((await client.recover(saved.id)).record.digest).toBe(saved.digest)
    fail = null
    const next = await client.save(base, sim.snapshot(), saved)
    expect((await client.recover(saved.id)).record.digest).toBe(next.digest)
    expect((await readdir(join(api.directory, folder))).some((name) => name.endsWith('.tmp'))).toBe(true)
  })
  it.each(['ENOSPC', 'EACCES', 'EROFS'])('reports %s and retains a recoverable checkpoint', async (code) => {
    const { sim, base, saved } = await fixture(); sim.observe(1030)
    fail = async () => { throw Object.assign(new Error('write failed'), { code }) }
    await expect(client.save(base, sim.snapshot(), saved)).rejects.toThrow(code === 'ENOSPC' ? 'Disk full' : 'permission')
    expect((await client.recover(saved.id)).record.digest).toBe(saved.digest)
  })
  it('serializes concurrent clients and rejects stale save, rename and delete revisions', async () => {
    const { sim, base, saved } = await fixture(), other = new DiskSessionStore(); sim.observe(1030)
    const results = await Promise.allSettled([client.save(base, sim.snapshot(), saved), other.save(base, sim.snapshot(), saved)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
    await expect(other.rename(saved.id, 'Stale', saved.revision)).rejects.toThrow('changed')
    await expect(other.delete(saved.id, saved.revision)).rejects.toThrow('changed')
  })
  it('recovers after backend restart and gives a new browser client the same state', async () => {
    const { saved } = await fixture(); await api.storage.close()
    const restarted = new SessionStorage({ directory: api.directory })
    try { expect((await restarted.restore(saved.id)).record).toEqual(saved); expect(await restarted.getHistory(saved.historyId)).toEqual(sessionHistory(2200)) }
    finally { await restarted.close() }
  })
  it('refuses a second backend writer for the same directory', async () => {
    await client.status()
    const other = new SessionStorage({ directory: api.directory })
    await expect(other.status()).rejects.toThrow('Another backend')
    await other.close()
  })
  it('validates checkpoint SHA-256 before recovery', async () => {
    const { saved } = await fixture()
    const pointer = JSON.parse(await readFile(join(api.directory, 'sessions', `${saved.id}.json`), 'utf8')) as { hash: string }
    const file = join(api.directory, 'checkpoints', `${pointer.hash}.json`)
    await writeFile(file, (await readFile(file, 'utf8')).replace('Disk backtest', 'Tampered name'))
    await expect(client.recover(saved.id)).rejects.toThrow('corrupt')
  })
  it('rejects wrong history and equity hashes before publication', async () => {
    const { saved } = await fixture()
    await expect(api.storage.putHistory('f'.repeat(64), sessionHistory())).rejects.toMatchObject({ code: 'HISTORY_FINGERPRINT_MISMATCH' })
    const record = { ...saved, revision: 2 }; record.digest = await recordDigest(record)
    await expect(api.storage.save(record, [{ hash: 'f'.repeat(64), points: [] }], 1)).rejects.toThrow('hash')
    expect((await client.recover(saved.id)).record).toEqual(saved)
  })
  it('restores a 90-day session with all incremental equity chunks and drawdown intact', async () => {
    const { saved, sim } = await fixture(90 * 1440, 90 * 1440 - 1)
    const restored = await client.recover(saved.id)
    expect(restored.ledger.count).toBe(129600); expect(restored.checkpoint.equity).toEqual(sim.snapshot().checkpoint.equity)
    expect(historyCandles(restored.history)).toHaveLength(129600); expect(saved.chunkHashes).toHaveLength(127)
  }, 20000)
})
describe('narrow localhost API', () => {
  it.each(['bad', '../secret', '%2e%2e', '%2fetc%2fpasswd', 'x'.repeat(200)])('rejects invalid identifier %s', async (id) => {
    const response = await api.fetch(`/api/storage/sessions/${id}`)
    expect(response.ok).toBe(false)
  })
  it('rejects cross-origin writes, foreign Host headers and requests without Origin', async () => {
    const status = await new Promise<number>((resolve) => { const req = request(`${api.origin}/api/storage/status`, { headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode!) }); req.end() })
    expect(status).toBe(403)
    expect((await api.fetch('/api/storage/sessions/' + crypto.randomUUID(), { method: 'POST', headers: { Origin: 'https://evil.example' } })).status).toBe(403)
    expect((await api.fetch('/api/storage/sessions/' + crypto.randomUUID(), { method: 'POST', headers: { Origin: '' } })).status).toBe(403)
  })
  it.each(['{', '[]', 'null', '{"__proto__":{}}', '{"revision":1e999}'])('rejects malformed JSON %s', async (body) => {
    const response = await api.fetch(`/api/storage/sessions/${crypto.randomUUID()}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    expect(response.status).toBe(400)
  })
  it('rejects unsupported content types and oversized payloads', async () => {
    const path = `/api/storage/sessions/${crypto.randomUUID()}`
    expect((await api.fetch(path, { method: 'POST', body: '{}' })).status).toBe(415)
    expect((await api.fetch(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x'.repeat(5000), revision: 1 }) })).status).toBe(413)
  })
})

it('isolates an unreadable session while retaining readable sessions and explicit deletion', async () => {
  const first = await fixture(), second = await fixture()
  const manifest = JSON.parse(await readFile(join(api.directory, 'sessions', `${first.saved.id}.json`), 'utf8')) as { hash: string }
  await writeFile(join(api.directory, 'checkpoints', `${manifest.hash}.json`), '{}')
  const rows = await client.list()
  expect(rows.map((row) => row.id)).toEqual([second.saved.id]); expect(client.listErrors[0].id).toBe(first.saved.id)
  await client.delete(first.saved.id, first.saved.revision)
  expect(await client.list()).toHaveLength(1); expect(client.listErrors).toHaveLength(0)
})

it.each(['equity', 'history'])('detects tampered %s data immediately during restoration', async (kind) => {
  const { saved } = await fixture()
  const hash = kind === 'equity' ? saved.chunkHashes[0] : saved.historyId
  const path = join(api.directory, kind, `${hash}.json.gz`)
  const source = gunzipSync(await readFile(path)).toString()
  const tampered = kind === 'equity' ? source.replace('"cashUsd":10000', '"cashUsd":9999') : source.replace('"close":1.1001', '"close":1.1002')
  expect(tampered).not.toBe(source)
  await writeFile(path, gzipSync(tampered))
  await expect(client.recover(saved.id)).rejects.toThrow()
})

it('allows only one concurrent starter to recover a stale backend lock', async () => {
  await writeFile(join(api.directory, 'writer.lock'), JSON.stringify({ pid: 2147483647 }))
  const first = new SessionStorage({ directory: api.directory }), second = new SessionStorage({ directory: api.directory })
  try {
    const results = await Promise.allSettled([first.status(), second.status()])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
  } finally { await first.close(); await second.close() }
})
