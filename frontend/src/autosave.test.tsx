// @vitest-environment jsdom
import { diskApiFixture } from '../../tests/diskApiFixture'
import { DiskSessionStore } from './diskSessionStore'
import { StrictMode, act } from 'react'
import { createRoot } from 'react-dom/client'
import { webcrypto } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutosaveQueue } from './autosave'
import { useSessionPersistence } from './useSessionPersistence'
import { SessionStore } from './sessionStore'
import { sessionSimulation } from './sessionFixtures'
import type { SessionSnapshot } from './sessionTypes'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let disk: Awaited<ReturnType<typeof diskApiFixture>>
beforeEach(async () => { disk = await diskApiFixture(); vi.stubGlobal('fetch', disk.fetch); vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange); vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('BroadcastChannel', undefined) })
afterEach(async () => { await disk.close(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals() })
async function settle(check: () => boolean) {
  for (let i = 0; i < 100; i++) { await act(async () => { await delay(2) }); if (check()) return }
  throw new Error('Autosave did not settle')
}
describe('autosave scheduling and StrictMode safety', () => {
  it('coalesces rapid queued requests and keeps writes serial', async () => {
    let release!: () => void, calls = 0
    const queue = new AutosaveQueue(async () => { if (++calls === 1) await new Promise<void>((resolve) => { release = resolve }) })
    const first = queue.flush(); for (let i = 0; i < 100; i++) queue.flush()
    expect(calls).toBe(1); release(); await first; expect(calls).toBe(2)
    queue.dispose(); await queue.flush(); expect(calls).toBe(2)
  })
  it('retries a failed queue without treating it as committed', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('abort')).mockResolvedValueOnce(undefined), queue = new AutosaveQueue(save)
    await expect(queue.flush()).rejects.toThrow('abort'); await queue.flush(); expect(save).toHaveBeenCalledTimes(2)
  })
  it('batches playing observations at 5 seconds, promptly saves manual actions and pause, and flushes hidden pages', async () => {
    const sim = sessionSimulation(); sim.observe()
    let snapshot: SessionSnapshot = sim.snapshot(true, 100), action = 0
    const workspace = snapshot.checkpoint.workspace, root = createRoot(document.createElement('div'))
    let sessions!: ReturnType<typeof useSessionPersistence>
    // Keep timer scheduling deterministic. Filesystem/HTTP confirmation is
    // exercised with real timers in the storage and recovery suites.
    const timerStore = new SessionStore()
    vi.spyOn(DiskSessionStore.prototype, 'status').mockResolvedValue({ directory: '/tmp/timer-fixture' })
    vi.spyOn(DiskSessionStore.prototype, 'list').mockResolvedValue([])
    vi.spyOn(DiskSessionStore.prototype, 'cacheHistory').mockResolvedValue()
    const save = vi.spyOn(DiskSessionStore.prototype, 'save').mockImplementation((...args) => timerStore.save(...args))
    function Harness() { sessions = useSessionPersistence({ history: sim.history, snapshot, actionVersion: action,
      pause: () => {}, captureViewport: () => workspace.viewport, download: async () => sim.history, restore: () => {}, fresh: () => {} }); return null }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const render = () => act(async () => root.render(<StrictMode><Harness /></StrictMode>))
    try {
      await render(); await settle(() => sessions.initialized)
      await act(async () => vi.advanceTimersByTime(150)); await settle(() => { if (sessions.error) throw new Error(sessions.error); return sessions.saveStatus === 'Saved' })
      expect(save).toHaveBeenCalledTimes(1)
      for (let i = 1; i <= 19; i++) {
        sim.observe(i); snapshot = sim.snapshot(true, 100); snapshot.checkpoint.workspace = workspace
        await render(); await act(async () => vi.advanceTimersByTime(250))
      }
      expect(save).toHaveBeenCalledTimes(1)
      await act(async () => vi.advanceTimersByTime(100)); await settle(() => save.mock.calls.length === 2 && sessions.saveStatus === 'Saved')
      expect(save.mock.calls[1][1].checkpoint.executionCursor).toBe(20)
      action++; await render(); await act(async () => vi.advanceTimersByTime(150)); await settle(() => save.mock.calls.length === 3 && sessions.saveStatus === 'Saved')
      snapshot = { ...snapshot, checkpoint: { ...snapshot.checkpoint, replay: { ...snapshot.checkpoint.replay, playing: false } } }
      await render(); await act(async () => vi.advanceTimersByTime(150)); await settle(() => save.mock.calls.length === 4 && sessions.saveStatus === 'Saved')
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
      await act(async () => document.dispatchEvent(new Event('visibilitychange')))
      await settle(() => save.mock.calls.length === 5 && sessions.saveStatus === 'Saved')
      expect(sessions.savedAt).not.toBeNull(); expect(sessions.error).toBeNull()
    } finally { await act(async () => root.unmount()) }
  })
})

it('does not confirm Saved when history cannot be persisted on disk', async () => {
  const sim = sessionSimulation(); sim.observe()
  const snapshot = sim.snapshot(), root = createRoot(document.createElement('div'))
  vi.spyOn(DiskSessionStore.prototype, 'cacheHistory').mockRejectedValue(new DOMException('full', 'QuotaExceededError'))
  let sessions!: ReturnType<typeof useSessionPersistence>
  function Harness() { sessions = useSessionPersistence({ history: sim.history, snapshot, actionVersion: 0, pause: () => {}, captureViewport: () => null, download: async () => sim.history, restore: () => {}, fresh: () => {} }); return null }
  try {
    await act(async () => root.render(<Harness />))
    await settle(() => sessions.saveStatus === 'Error')
    expect(sessions.savedAt).toBeNull(); expect(sessions.error).not.toBeNull()
    expect((await disk.storage.list()).sessions).toHaveLength(0)
  } finally { await act(async () => root.unmount()) }
})

it('keeps startup closed on a connection failure and opens only after a successful retry', async () => {
  const sim = sessionSimulation(); sim.observe()
  vi.spyOn(DiskSessionStore.prototype, 'status').mockRejectedValueOnce(new Error('backend unavailable'))
  const root = createRoot(document.createElement('div'))
  let sessions!: ReturnType<typeof useSessionPersistence>
  function Harness() { sessions = useSessionPersistence({ history: sim.history, snapshot: sim.snapshot(), actionVersion: 0, pause: () => {}, captureViewport: () => null, download: async () => sim.history, restore: () => {}, fresh: () => {} }); return null }
  try {
    await act(async () => root.render(<Harness />)); await settle(() => sessions.error !== null)
    expect(sessions.initialized).toBe(false); expect(sessions.activeId).toBeNull(); expect(sessions.awaitingChoice).toBe(true)
    expect((await disk.storage.list()).sessions).toHaveLength(0)
    await act(async () => sessions.retry()); await settle(() => sessions.initialized)
    expect(sessions.awaitingChoice).toBe(false); expect(sessions.activeId).not.toBeNull()
  } finally { await act(async () => root.unmount()) }
})

it('displays Saved only after the filesystem manifest is published and confirmed', async () => {
  await disk.close()
  let release: (() => void) | undefined
  disk = await diskApiFixture({ beforePublish: (path) => path.includes('/sessions/') ? new Promise<void>((r) => { release = r }) : Promise.resolve() })
  vi.stubGlobal('fetch', disk.fetch)
  const sim = sessionSimulation(); sim.observe(); const snapshot = sim.snapshot()
  const root = createRoot(document.createElement('div'))
  let sessions!: ReturnType<typeof useSessionPersistence>
  function Harness() { sessions = useSessionPersistence({ history: sim.history, snapshot, actionVersion: 0, pause: () => {}, captureViewport: () => null, download: async () => sim.history, restore: () => {}, fresh: () => {} }); return null }
  try {
    await act(async () => root.render(<Harness />)); await settle(() => !!release)
    expect(sessions.saveStatus).toBe('Saving'); expect(sessions.savedAt).toBeNull()
    await act(async () => release!()); await settle(() => sessions.saveStatus === 'Saved')
    expect(sessions.savedAt).not.toBeNull()
  } finally { release?.(); await act(async () => root.unmount()) }
})
