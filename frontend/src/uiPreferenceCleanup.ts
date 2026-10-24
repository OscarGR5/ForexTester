import { uiKey, UI_PREFIX } from './uiPreferences'

const LOCK = 'forextester-ui-preference-maintenance'
const unsafeTabs = 'UI preference cleanup could not verify other tabs. Close other ForexTester tabs and retry in a browser with Web Locks support.'

// Every app tab holds a shared lease before creating an unsaved session. An
// exclusive lease excludes even suspended tabs and tabs opening during cleanup.
export class PreferenceTabGuard {
  private release: (() => void) | null = null
  private held: Promise<unknown> | null = null
  private stopped = false
  constructor(private locks: LockManager | undefined = globalThis.navigator?.locks) {}
  async start() {
    if (!this.locks || this.stopped) return
    await new Promise<void>((resolve, reject) => {
      this.held = this.locks!.request(LOCK, { mode: 'shared' }, () => new Promise<void>(release => {
        this.release = release
        if (this.stopped) release()
        resolve()
      }))
      void this.held.catch(reject)
    })
  }
  stop() { this.stopped = true; this.release?.(); this.release = null }
  async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.locks || this.stopped || !this.release) throw new Error(unsafeTabs)
    this.release(); this.release = null
    await this.held
    try {
      return await this.locks.request(LOCK, { mode: 'exclusive', ifAvailable: true }, async lock => {
        if (!lock) throw new Error(unsafeTabs)
        return operation()
      })
    } finally { await this.start() }
  }
}

export interface PreferenceCandidate { key: string; value: string }
export interface PreferenceCleanupPreview { candidates: PreferenceCandidate[]; error: string | null }
export interface PreferenceCleanupResult { removed: number; error: string | null }
interface Inventory { disk: () => Promise<{ id: string }[]>; legacy: () => Promise<{ id: string }[]>; active: () => string | null }

async function protectedIds(inventory: Inventory) {
  const [disk, legacy] = await Promise.all([inventory.disk(), inventory.legacy()])
  if (![...disk, ...legacy].every(row => typeof row.id === 'string' && row.id.length)) throw new Error('Session inventory is unreadable. UI preferences were kept.')
  return new Set([...disk.map(row => row.id), ...legacy.map(row => row.id), inventory.active()])
}
export async function previewUiCleanup(inventory: Inventory, storage: Storage = window.localStorage): Promise<PreferenceCandidate[]> {
  const ids = await protectedIds(inventory), candidates: PreferenceCandidate[] = []
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (!key?.startsWith(UI_PREFIX) || !key.slice(UI_PREFIX.length) || ids.has(key.slice(UI_PREFIX.length))) continue
    const value = storage.getItem(key)
    if (value !== null) candidates.push({ key, value })
  }
  return candidates
}
export async function removeUnusedUi(candidates: PreferenceCandidate[], inventory: Inventory, storage: Storage = window.localStorage): Promise<PreferenceCleanupResult> {
  // Re-read both inventories after confirmation. Only unchanged previewed keys
  // are eligible; newly discovered keys require a new preview and confirmation.
  const ids = await protectedIds(inventory)
  let removed = 0, error: string | null = null
  for (const { key, value } of candidates) {
    if (!key.startsWith(UI_PREFIX) || !key.slice(UI_PREFIX.length) || ids.has(key.slice(UI_PREFIX.length))) continue
    try {
      if (storage.getItem(key) !== value) continue
      storage.removeItem(key); removed++
    } catch { error = 'Some UI preferences could not be removed. Preview and retry cleanup.' }
  }
  return { removed, error }
}
export async function removeDeletedUi(id: string, legacy: () => Promise<{ id: string }[]>) {
  // The caller must await successful backend deletion first. Originals retained
  // after migration still own the same presentation key, including receipted ones.
  const rows = await legacy()
  if (rows.some(row => typeof row.id !== 'string' || row.id === id)) return
  window.localStorage.removeItem(uiKey(id))
}
