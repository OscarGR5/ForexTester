// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import { PreferenceTabGuard, previewUiCleanup, removeUnusedUi } from './uiPreferenceCleanup'
import { GLOBAL_UI_ID, uiKey, UI_PREFIX } from './uiPreferences'

beforeEach(() => window.localStorage.clear())
const inventory = () => ({ disk: vi.fn(async () => [{ id: 'saved' }]), legacy: vi.fn(async () => [{ id: 'legacy' }]), active: () => 'active' })

it('preserves global indicator settings during orphan cleanup, including stale candidates', async () => {
  const key = uiKey(GLOBAL_UI_ID), value = JSON.stringify({ untakenLevels: { enabled: true, count: 15, pivotStrength: 2 } })
  localStorage.setItem(key, value)
  expect(await previewUiCleanup(inventory())).toEqual([])
  expect(await removeUnusedUi([{ key, value }], inventory())).toEqual({ removed: 0, error: null })
  expect(localStorage.getItem(key)).toBe(value)
})

it('previews only exact-prefix orphans and preserves disk, legacy, active and unrelated entries', async () => {
  for (const id of ['saved', 'legacy', 'active', 'orphan']) localStorage.setItem(uiKey(id), id)
  localStorage.setItem('unrelated', 'keep'); localStorage.setItem('forextester:ui:v10:orphan', 'keep'); localStorage.setItem(UI_PREFIX, 'uncertain')
  const source = inventory(), preview = await previewUiCleanup(source)
  expect(preview).toEqual([{ key: uiKey('orphan'), value: 'orphan' }])
  expect(localStorage.length).toBe(7)
  expect(await removeUnusedUi(preview, source)).toEqual({ removed: 1, error: null })
  expect(localStorage.length).toBe(6)
  for (const id of ['saved', 'legacy', 'active']) expect(localStorage.getItem(uiKey(id))).toBe(id)
  expect(localStorage.getItem('unrelated')).toBe('keep')
  expect(await removeUnusedUi(preview, source)).toEqual({ removed: 0, error: null })
})

it('revalidates inventories and values and never expands the confirmed preview', async () => {
  const source = inventory()
  for (const id of ['newly-saved', 'newly-legacy', 'changed', 'remove']) localStorage.setItem(uiKey(id), 'old')
  const preview = await previewUiCleanup(source)
  source.disk.mockResolvedValue([{ id: 'newly-saved' }]); source.legacy.mockResolvedValue([{ id: 'newly-legacy' }])
  localStorage.setItem(uiKey('changed'), 'new'); localStorage.setItem(uiKey('after-preview'), 'new')
  expect((await removeUnusedUi(preview, source)).removed).toBe(1)
  for (const id of ['newly-saved', 'newly-legacy', 'changed', 'after-preview']) expect(localStorage.getItem(uiKey(id))).not.toBeNull()
})

it.each(['disk', 'legacy'] as const)('retains every key if %s inventory cannot be verified', async kind => {
  localStorage.setItem(uiKey('orphan'), 'old')
  const source = inventory(), preview = await previewUiCleanup(source)
  source[kind].mockRejectedValue(new Error('unavailable'))
  await expect(previewUiCleanup(source)).rejects.toThrow('unavailable')
  await expect(removeUnusedUi(preview, source)).rejects.toThrow('unavailable')
  expect(localStorage.getItem(uiKey('orphan'))).toBe('old')
})

it('reports partial Local Storage failures with the actual removal count', async () => {
  localStorage.setItem(uiKey('orphan'), 'value')
  const source = inventory(), preview = await previewUiCleanup(source)
  const spy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('denied') })
  expect(await removeUnusedUi(preview, source)).toEqual({ removed: 0, error: expect.stringContaining('could not be removed') })
  spy.mockRestore()
})

it('refuses cleanup when Web Locks is unavailable', async () => {
  const guard = new PreferenceTabGuard(undefined), operation = vi.fn()
  await guard.start()
  await expect(guard.exclusive(operation)).rejects.toThrow('could not verify other tabs')
  expect(operation).not.toHaveBeenCalled(); guard.stop()
})
