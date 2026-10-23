// @vitest-environment jsdom
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
beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange); vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('BroadcastChannel', undefined) })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals() })
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
    const save = vi.spyOn(SessionStore.prototype, 'save')
    function Harness() { sessions = useSessionPersistence({ history: sim.history, snapshot, actionVersion: action,
      pause: () => {}, captureViewport: () => workspace.viewport, download: async () => sim.history, restore: () => {}, fresh: () => {} }); return null }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const render = () => act(async () => root.render(<StrictMode><Harness /></StrictMode>))
    try {
      await render(); await settle(() => sessions.initialized)
      await act(async () => vi.advanceTimersByTime(150)); await settle(() => sessions.saveStatus === 'Saved')
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

it('commits the smaller trading snapshot when storing history exceeds quota, with a visible recovery limitation', async () => {
  const sim = sessionSimulation(); sim.observe()
  const snapshot = sim.snapshot(), root = createRoot(document.createElement('div'))
  vi.spyOn(SessionStore.prototype, 'cacheHistory').mockRejectedValue(new DOMException('full', 'QuotaExceededError'))
  let sessions!: ReturnType<typeof useSessionPersistence>
  function Harness() { sessions = useSessionPersistence({ history: sim.history, snapshot, actionVersion: 0, pause: () => {}, captureViewport: () => null, download: async () => sim.history, restore: () => {}, fresh: () => {} }); return null }
  try {
    await act(async () => root.render(<Harness />))
    await settle(() => sessions.cacheWarning !== null)
    expect(sessions.saveStatus).toBe('Saved'); expect(sessions.savedAt).not.toBeNull(); expect(sessions.error).toBeNull()
    expect(sessions.cacheWarning).toContain('Trading checkpoint was saved')
    const stored = await new SessionStore().list(); expect(stored[0].checkpoint.executionCursor).toBe(1)
  } finally { await act(async () => root.unmount()) }
})
