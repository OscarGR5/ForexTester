import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lstat, readFile, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { diskApiFixture } from '../../tests/diskApiFixture.js'
import { DiskSessionStore } from '../../frontend/src/diskSessionStore.js'
import { historyFingerprint } from '../../frontend/src/sessionCodec.js'
import { HistoryLoader } from '../../frontend/src/historyLoader.js'
import { manualPermission, sessionHistory, sessionSimulation } from '../../frontend/src/sessionFixtures.js'
import { requestEntry, requestClose } from '../../frontend/src/trading.js'
import { repairableHistory } from '../../frontend/src/storageProtocol.js'

let api: Awaited<ReturnType<typeof diskApiFixture>>, client: DiskSessionStore
let failPublish: ((path: string) => Promise<void>) | undefined, failRemove: ((path: string) => Promise<void>) | undefined
beforeEach(async () => {
  failPublish = undefined; failRemove = undefined
  api = await diskApiFixture({ beforePublish: (p) => failPublish?.(p) ?? Promise.resolve(), beforeRemove: (p) => failRemove?.(p) ?? Promise.resolve() })
  vi.stubGlobal('fetch', api.fetch); client = new DiskSessionStore()
})
afterEach(async () => { vi.unstubAllGlobals(); await api.close() })
async function fixture(history = sessionHistory(30)) {
  const sim = sessionSimulation(history); sim.observe()
  sim.state = requestEntry(sim.state, 'buy', .1, 1.098, manualPermission); sim.observe(3)
  sim.state = requestClose(sim.state, sim.state.positions[0].id, manualPermission); sim.observe(4)
  const base = { id: crypto.randomUUID(), name: 'Maintenance fixture', createdAt: new Date().toISOString(), range: { from: history.tradingFrom, to: history.to }, historyId: await historyFingerprint(history), totalCandles: history.bid.length }
  await client.cacheHistory(base.historyId, history)
  return { sim, base, saved: await client.save(base, sim.snapshot(), null) }
}
async function restoreBackup(id: string, original: (range: import('../../frontend/src/history.js').DateRange) => Promise<import('../../frontend/src/historyLoader.js').LoadedHistory>) {
  const { record } = await client.call<{ record: import('../../frontend/src/sessionTypes.js').SessionRecord }>(`/sessions/${id}`)
  const history = await original(record.range)
  const body = await import('../../frontend/src/sessionCodec.js')
  const validated = body.validatedHistory(history)
  if (await historyFingerprint(validated) !== record.historyId) throw Object.assign(new Error('Original fingerprint differs'), { code: 'HISTORY_FINGERPRINT_MISMATCH' })
  await client.cacheHistory(record.historyId, validated)
}
const historyPath = (id: string) => join(api.directory, 'history', `${id}.json.gz`)
const old = new Date(Date.now() - 8 * 86_400_000)
async function age(path: string) { await utimes(path, old, old) }
async function obsolete(folder = 'checkpoints', bytes = 17) {
  const path = join(api.directory, folder, `${'f'.repeat(64)}.${folder === 'checkpoints' ? 'json' : 'json.gz'}`)
  await writeFile(path, Buffer.alloc(bytes)); await age(path); return path
}
async function inventory() {
  const result: Record<string, string> = {}
  for (const folder of ['sessions', 'checkpoints', 'equity', 'history', 'imports']) for (const name of await readdir(join(api.directory, folder))) result[`${folder}/${name}`] = (await readFile(join(api.directory, folder, name))).toString('base64')
  return result
}

describe('explicit exact-history repair on real files', () => {
  it.each(['missing', 'gzip', 'json', 'observation', 'fingerprint'])('repairs %s history shared by two sessions without changing checkpoint, cursor, fees, journal or equity', async (kind) => {
    const first = await fixture(), second = await fixture()
    const path = historyPath(first.saved.historyId)
    if (kind === 'missing') await rm(path)
    else if (kind === 'gzip') await writeFile(path, 'broken gzip')
    else if (kind === 'json') await writeFile(path, gzipSync('{'))
    else {
      const altered = structuredClone(first.sim.history)
      altered.ask[0].close += kind === 'observation' ? 10 : .00001
      await writeFile(path, gzipSync(JSON.stringify(altered)))
    }
    const expectedCode = kind === 'missing' ? 'HISTORY_MISSING' : 'HISTORY_CORRUPT'
    const head = await api.fetch(`/api/storage/history/${first.saved.historyId}`, { method: 'HEAD' })
    expect(head.headers.get('X-Storage-Error-Code')).toBe(expectedCode)
    const download = vi.fn(async () => first.sim.history)
    await expect(client.recover(first.saved.id, download)).rejects.toMatchObject({ code: expectedCode })
    expect(download).not.toHaveBeenCalled() // Never download during normal resume.
    await restoreBackup(first.saved.id, download)
    expect(download).toHaveBeenCalledExactlyOnceWith(first.saved.range)
    for (const { saved, sim } of [first, second]) {
      const restored = await client.recover(saved.id)
      expect(restored.record).toEqual(saved); expect(restored.checkpoint).toEqual(sim.snapshot().checkpoint)
      expect(restored.ledger.count).toBe(sim.ledger.count); expect(restored.ledger.cashUsd).toBe(sim.ledger.cashUsd)
    }
  })
  it('rejects mismatching replacement in both browser and API while preserving every existing file, then allows retry', async () => {
    const { saved, sim } = await fixture(); await writeFile(historyPath(saved.historyId), 'corrupt')
    const before = await inventory(), different = structuredClone(sim.history); different.bid[0].close += .00001
    await expect(restoreBackup(saved.id, async () => different)).rejects.toMatchObject({ code: 'HISTORY_FINGERPRINT_MISMATCH' })
    await expect(client.call(`/history/${saved.historyId}`, 'PUT', different)).rejects.toMatchObject({ code: 'HISTORY_FINGERPRINT_MISMATCH' })
    expect(await inventory()).toEqual(before)
    await restoreBackup(saved.id, async () => sim.history)
    expect((await client.recover(saved.id)).record).toEqual(saved)
  })
  it('validates every bid/ask observation before replacement', async () => {
    const { saved, sim } = await fixture(); await rm(historyPath(saved.historyId))
    const invalid = structuredClone(sim.history); invalid.ask[15].high = 0
    await expect(restoreBackup(saved.id, async () => invalid)).rejects.toThrow()
    await expect(api.storage.putHistory(saved.historyId, invalid)).rejects.toMatchObject({ code: 'HISTORY_INVALID' })
    expect((await api.storage.get(saved.id)).digest).toBe(saved.digest)
    await expect(lstat(historyPath(saved.historyId))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('keeps backend/network and unavailable directories distinct from history corruption', async () => {
    const { saved } = await fixture()
    const offline = vi.fn(async () => { throw new TypeError('offline') }); vi.stubGlobal('fetch', offline)
    const error = await client.recover(saved.id).catch((e) => e)
    expect(error.code).toBe('STORAGE_UNAVAILABLE'); expect(repairableHistory(error)).toBe(false)
    await expect(client.cacheHistory(saved.historyId, sessionHistory(30))).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
    vi.stubGlobal('fetch', api.fetch)
    await rename(join(api.directory, 'history'), join(api.directory, 'history-offline'))
    try { await expect(client.recover(saved.id)).rejects.toMatchObject({ code: 'STORAGE_DATA_MISSING' }) }
    finally { await rename(join(api.directory, 'history-offline'), join(api.directory, 'history')) }
    expect((await client.recover(saved.id)).record).toEqual(saved)
  })
  it('leaves corrupt original intact on interrupted repair, and never rewrites a valid shared object', async () => {
    const { saved, sim } = await fixture(), path = historyPath(saved.historyId)
    await writeFile(path, 'original damaged bytes')
    failPublish = async (p) => { if (p === path) throw Object.assign(new Error('interrupted'), { code: 'EIO' }) }
    await expect(restoreBackup(saved.id, async () => sim.history)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
    expect(await readFile(path, 'utf8')).toBe('original damaged bytes')
    expect((await api.storage.get(saved.id)).digest).toBe(saved.digest)
    failPublish = undefined; await restoreBackup(saved.id, async () => sim.history)
    const info = await lstat(path)
    failPublish = async () => { throw new Error('Must not republish valid history') }
    await restoreBackup(saved.id, async () => sim.history)
    expect((await lstat(path)).mtimeMs).toBe(info.mtimeMs)
    expect((await client.recover(saved.id)).record).toEqual(saved)
  })
  it('never calls a historical provider when the original legacy dataset is missing', async () => {
    const { saved } = await fixture(); await rm(historyPath(saved.historyId))
    const download = vi.fn(async () => sessionHistory(30))
    await expect(client.repairHistory(saved.id, download)).rejects.toThrow('original Dukascopy provider dataset')
    expect(download).not.toHaveBeenCalled()
  })

})

describe('conservative serialized mark and sweep', () => {
  it('previews without changes, protects recent files and reclaims only seven-day-old known objects and abandoned writes', async () => {
    await client.status()
    const expired = await obsolete(), recent = join(api.directory, 'equity', `${'e'.repeat(64)}.json.gz`)
    await writeFile(recent, 'recent')
    const tmp = join(api.directory, 'sessions', `${crypto.randomUUID()}.json.${crypto.randomUUID()}.tmp`)
    await writeFile(tmp, 'temp'); await age(tmp)
    const unknown = join(api.directory, 'checkpoints', 'unknown.json'); await writeFile(unknown, 'keep'); await age(unknown)
    const before = await inventory(), preview = await client.previewCleanup()
    expect(preview).toMatchObject({ safe: true, candidateFiles: 2, reclaimableBytes: 21, categories: { temporary: { files: 1, bytes: 4 } } })
    expect(await inventory()).toEqual(before)
    expect(await client.cleanup()).toMatchObject({ removedFiles: 2, reclaimedBytes: 21, remainingFiles: 0 })
    await expect(lstat(expired)).rejects.toThrow(); expect(await readFile(recent, 'utf8')).toBe('recent'); expect(await readFile(unknown, 'utf8')).toBe('keep')
  })
  it('protects active checkpoints/equity and shared history, retains tombstones, receipts and locks, restores multiple sessions and permits later incremental saves', async () => {
    const first = await fixture(), second = await fixture(), third = await fixture()
    await client.delete(first.saved.id, first.saved.revision)
    const receipt = join(api.directory, 'imports', `${crypto.randomUUID()}.json`); await writeFile(receipt, '{}')
    for (const folder of ['checkpoints', 'equity', 'history', 'sessions', 'imports']) for (const name of await readdir(join(api.directory, folder))) await age(join(api.directory, folder, name))
    const extra = await obsolete('history', 33)
    const result = await client.cleanup(); expect(result.safe).toBe(true); expect(result.reclaimedBytes).toBeGreaterThanOrEqual(33)
    expect(await readFile(receipt, 'utf8')).toBe('{}'); expect((await api.storage.migration(receipt.split('/').at(-1)!.slice(0, -5)))).toEqual({})
    const tombstone = JSON.parse(await readFile(join(api.directory, 'sessions', `${first.saved.id}.json`), 'utf8')); expect(tombstone.hash).toBeNull()
    expect((await lstat(join(api.directory, 'writer.lock'))).isFile()).toBe(true)
    await expect(client.recover(first.saved.id)).rejects.toThrow('not found'); await expect(lstat(extra)).rejects.toThrow()
    for (const { saved } of [second, third]) expect((await client.recover(saved.id)).record).toEqual(saved)
    second.sim.observe(8); const next = await client.save(second.base, second.sim.snapshot(), second.saved)
    expect((await client.recover(second.saved.id)).record).toEqual(next)
  })
  it.each(['manifest', 'checkpoint', 'equity', 'history'])('fails closed for unreadable %s, even if preview previously succeeded', async (kind) => {
    const { saved } = await fixture(); await obsolete(); expect((await client.previewCleanup()).safe).toBe(true)
    const manifestPath = join(api.directory, 'sessions', `${saved.id}.json`)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const path = kind === 'manifest' ? manifestPath : kind === 'checkpoint' ? join(api.directory, 'checkpoints', `${manifest.hash}.json`) : kind === 'equity' ? join(api.directory, 'equity', `${saved.chunkHashes[0]}.json.gz`) : historyPath(saved.historyId)
    await writeFile(path, 'unreadable')
    const before = await inventory()
    expect(await client.previewCleanup()).toMatchObject({ safe: false, code: 'CLEANUP_UNSAFE', candidateFiles: 0 })
    expect(await client.cleanup()).toMatchObject({ safe: false, removedFiles: 0 })
    expect(await inventory()).toEqual(before)
  })
  it('reports partial failures and allows a later attempt', async () => {
    await client.status(); const first = await obsolete('checkpoints', 17), second = await obsolete('equity', 23)
    failRemove = async (path) => { if (path === first) throw new Error('interrupted deletion') }
    expect(await client.cleanup()).toMatchObject({ safe: true, removedFiles: 1, reclaimedBytes: 23, remainingFiles: 1, failures: [{ file: `checkpoints/${'f'.repeat(64)}.json` }] })
    expect(await readFile(first)).toHaveLength(17); await expect(lstat(second)).rejects.toThrow()
    failRemove = undefined
    expect(await client.cleanup()).toMatchObject({ removedFiles: 1, reclaimedBytes: 17, remainingFiles: 0 })
  })
  it('recomputes references after preview when a previously unused history becomes active', async () => {
    const { saved, sim } = await fixture(); await client.delete(saved.id, saved.revision); await age(historyPath(saved.historyId))
    expect((await client.previewCleanup()).categories.history.files).toBe(1)
    const { saved: active } = await fixture(sim.history)
    expect(await client.cleanup()).toMatchObject({ removedFiles: 0 })
    expect((await client.recover(active.id)).history).toEqual(sim.history)
  })
  it.each(['file', 'directory', 'type'])('refuses symlinks/unexpected %s and leaves external targets untouched', async (kind) => {
    await client.status(); const external = join(api.directory, 'external'); await writeFile(external, 'untouched')
    if (kind === 'file') await symlink(external, join(api.directory, 'history', `${'f'.repeat(64)}.json.gz`))
    else if (kind === 'directory') { await rm(join(api.directory, 'history'), { recursive: true }); await symlink(api.directory, join(api.directory, 'history')) }
    else { const { mkdir } = await import('node:fs/promises'); await mkdir(join(api.directory, 'equity', `${'f'.repeat(64)}.json.gz`)) }
    expect(await client.cleanup()).toMatchObject({ safe: false, removedFiles: 0 })
    expect(await readFile(external, 'utf8')).toBe('untouched')
  })
  it('requires confirmation and rejects browser-supplied paths or traversal', async () => {
    await client.status(); await obsolete()
    await expect(client.call('/cleanup', 'POST', {})).rejects.toMatchObject({ code: 'STORAGE_REQUEST_INVALID' })
    expect((await api.fetch('/api/storage/cleanup/%2e%2e')).ok).toBe(false)
    expect((await client.previewCleanup()).candidateFiles).toBe(1)
  })
})

it('uses the seven-day modification-time boundary and retains younger objects', async () => {
  await client.status()
  const fixed = Date.now(), boundary = await obsolete('checkpoints'), younger = await obsolete('equity')
  const week = 7 * 86_400_000
  await utimes(boundary, new Date(fixed - week), new Date(fixed - week))
  await utimes(younger, new Date(fixed - week + 60_000), new Date(fixed - week + 60_000))
  const clock = vi.spyOn(Date, 'now').mockReturnValue(fixed)
  try { expect(await client.cleanup()).toMatchObject({ removedFiles: 1 }); expect((await lstat(younger)).isFile()).toBe(true) }
  finally { clock.mockRestore() }
})
it('retains candidates changed or replaced by a symlink after marking', async () => {
  await client.status(); const first = await obsolete('checkpoints'), second = await obsolete('equity')
  const outside = join(api.directory, 'external-original'); await writeFile(outside, 'preserved')
  failRemove = async (path) => {
    if (path === first) await writeFile(path, 'changed')
    if (path === second) { await rm(path); await symlink(outside, path) }
  }
  const result = await client.cleanup()
  expect(result).toMatchObject({ removedFiles: 0, remainingFiles: 2 }); expect(result.failures).toHaveLength(2)
  expect(await readFile(outside, 'utf8')).toBe('preserved')
})
it('preserves a valid original history object when the provider supplies different prices', async () => {
  const { saved, sim } = await fixture(), before = await inventory(), different = structuredClone(sim.history)
  different.ask[20].close += .00001
  await expect(restoreBackup(saved.id, async () => different)).rejects.toMatchObject({ code: 'HISTORY_FINGERPRINT_MISMATCH' })
  await expect(api.storage.putHistory(saved.historyId, different)).rejects.toMatchObject({ code: 'HISTORY_FINGERPRINT_MISMATCH' })
  expect(await inventory()).toEqual(before)
})

it('can re-upload the exact in-memory dataset after HEAD detects corrupt history on Save now', async () => {
  const { saved, sim } = await fixture(); await writeFile(historyPath(saved.historyId), 'corrupted gzip')
  await client.cacheHistory(saved.historyId, sim.history)
  expect((await client.recover(saved.id)).record).toEqual(saved)
})
it('does not treat an unclassified HEAD failure as permission to replace history', async () => {
  const request = vi.fn(async () => new Response(null, { status: 404 }))
  vi.stubGlobal('fetch', request)
  await expect(client.cacheHistory('f'.repeat(64), sessionHistory(30))).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
  expect(request).toHaveBeenCalledOnce()
})
