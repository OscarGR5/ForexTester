// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { webcrypto } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { diskApiFixture } from '../../tests/diskApiFixture'
import { DiskSessionStore } from './diskSessionStore'
import { useSessionPersistence } from './useSessionPersistence'
import { SessionControls } from './SessionControls'
import { historyFingerprint } from './sessionCodec'
import type { LoadedHistory } from './historyLoader'
import type { SessionSnapshot } from './sessionTypes'
import { sessionHistory, sessionSimulation } from './sessionFixtures'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let disk: Awaited<ReturnType<typeof diskApiFixture>>, store: DiskSessionStore
let container: HTMLDivElement, root: ReturnType<typeof createRoot>
beforeEach(async () => {
  disk = await diskApiFixture(); vi.stubGlobal('fetch', disk.fetch); vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('indexedDB', new IDBFactory())
  store = new DiskSessionStore(); container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); await disk.close(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const button = (name: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === name)!
async function click(name: string) { await act(async () => button(name).click()) }
async function waitFor(predicate: () => boolean) { for (let i = 0; i < 100 && !predicate(); i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)) }); expect(predicate()).toBe(true) }
async function harness() {
  const history = sessionHistory(10), sim = sessionSimulation(history); sim.observe(3)
  const historyId = await historyFingerprint(history)
  await store.cacheHistory(historyId, history)
  const record = await store.save({ id: crypto.randomUUID(), name: 'Repair UI', createdAt: new Date().toISOString(), range: { from: history.tradingFrom, to: history.to }, historyId, totalCandles: 10 }, sim.snapshot(), null)
  const download = vi.fn<Parameters<typeof useSessionPersistence>[0]['download']>(async () => history), restore = vi.fn()
  let sessions!: ReturnType<typeof useSessionPersistence>
  function Harness() {
    const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null)
    const [loadedHistory, setLoadedHistory] = useState<LoadedHistory | null>(null)
    sessions = useSessionPersistence({ history: loadedHistory, snapshot, actionVersion: 0, captureViewport: () => null, pause: vi.fn(), download,
      restore: (saved, source) => { restore(saved, source); setLoadedHistory(source); setSnapshot({ checkpoint: saved.checkpoint, ledger: saved.ledger }) }, fresh: vi.fn() })
    return <SessionControls sessions={sessions} range={record.range} timestamp={null} />
  }
  await act(async () => root.render(<Harness />)); await waitFor(() => sessions.initialized)
  return { record, history, download, restore, get sessions() { return sessions } }
}
it.each(['missing', 'corrupt'])('offers explicit repair for %s history, reports chunk progress and restores only on request', async (kind) => {
  const h = await harness(), path = join(disk.directory, 'history', `${h.record.historyId}.json.gz`)
  if (kind === 'missing') await rm(path); else await writeFile(path, 'corrupt')
  await click('Resume session'); await waitFor(() => !!h.sessions.repairTarget)
  expect(h.download).not.toHaveBeenCalled(); expect(h.restore).not.toHaveBeenCalled()
  expect(button('Repair historical data')).toBeTruthy()
  h.download.mockImplementation(async (_range, progress) => { progress?.({ completed: 2, total: 3 }); return h.history })
  await click('Repair historical data'); await waitFor(() => h.restore.mock.calls.length === 1)
  expect(h.restore.mock.calls[0][0].checkpoint).toEqual(h.record.checkpoint)
  expect(h.sessions.repairTarget).toBeNull(); expect(h.sessions.error).toBeNull()
})
it('keeps repair available after mismatched prices, with a backup/retry message and no state installation', async () => {
  const h = await harness(); await rm(join(disk.directory, 'history', `${h.record.historyId}.json.gz`))
  await click('Resume session'); await waitFor(() => !!h.sessions.repairTarget)
  const changed = structuredClone(h.history); changed.ask[0].close += .00001
  h.download.mockResolvedValue(changed)
  await click('Repair historical data'); await waitFor(() => !h.sessions.busy)
  expect(h.sessions.error).toContain('different historical data'); expect(h.sessions.error).toContain('backup')
  expect(h.sessions.conflict).toBe(false); expect(h.sessions.repairTarget?.id).toBe(h.record.id); expect(h.restore).not.toHaveBeenCalled()
  h.download.mockResolvedValue(h.history)
  await click('Repair historical data'); await waitFor(() => h.restore.mock.calls.length === 1)
})
it('does not offer repair or download when the backend is temporarily unavailable', async () => {
  const h = await harness()
  vi.stubGlobal('fetch', async () => { throw new TypeError('offline') })
  await click('Resume session'); await waitFor(() => !h.sessions.busy)
  expect(h.sessions.error).toContain('unavailable'); expect(h.sessions.repairTarget).toBeNull(); expect(h.download).not.toHaveBeenCalled()
})
it('requires confirmation for cleanup, and cancel preserves eligible files', async () => {
  const h = await harness()
  const path = join(disk.directory, 'checkpoints', `${'f'.repeat(64)}.json`)
  await writeFile(path, 'obsolete'); const { utimes, readFile } = await import('node:fs/promises'); const age = new Date(Date.now() - 8 * 86_400_000); await utimes(path, age, age)
  await click('Preview cleanup'); await waitFor(() => !!h.sessions.cleanupPreview)
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  await click('Clean up unused files'); expect(confirm).toHaveBeenCalledOnce(); expect(await readFile(path, 'utf8')).toBe('obsolete')
  confirm.mockReturnValue(true); await click('Clean up unused files'); await waitFor(() => !!h.sessions.cleanupResult)
  expect(h.sessions.cleanupResult).toMatchObject({ removedFiles: 1, reclaimedBytes: 8 })
})

it('repairs history for an already open session before flushing its pending checkpoint', async () => {
  const h = await harness()
  await click('Resume session'); await waitFor(() => h.restore.mock.calls.length === 1 && !h.sessions.busy)
  await rm(join(disk.directory, 'history', `${h.record.historyId}.json.gz`))
  await click('Resume / Manage sessions')
  // Normal resume flushes the open session first; missing history blocks that
  // save. Explicit repair must fix the shared object before retrying the flush.
  await click('Resume session'); await waitFor(() => !!h.sessions.repairTarget)
  expect(h.download).not.toHaveBeenCalled()
  await click('Repair historical data'); await waitFor(() => h.restore.mock.calls.length === 2 && !h.sessions.busy)
  expect(h.restore.mock.calls[1][0].checkpoint).toEqual(h.record.checkpoint)
  expect(h.sessions.error).toBeNull()
})
