import { PreferenceTabGuard, previewUiCleanup, removeUnusedUi, removeDeletedUi, type PreferenceCleanupPreview, type PreferenceCleanupResult } from './uiPreferenceCleanup'
import { historyCandles } from './history.js'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { accountRiskError } from './risk'
import { commissionConfigError } from './commissions'
import { AutosaveQueue } from './autosave'
import { historyFingerprint, validatedHistory } from './sessionCodec'
import { repairableHistory, type CleanupPreview, type CleanupResult } from './storageProtocol'
import { DiskSessionStore } from './diskSessionStore'
import { writeUi, readUi, defaultWorkspace, validWorkspace } from './uiPreferences'
import { RevisionConflict, SessionStore, storageError } from './sessionStore'
import type { DateRange } from './history'
import type { LoadedHistory, LoadProgress } from './historyLoader'
import type { Hydration, SessionRecord, SessionSnapshot } from './sessionTypes'

interface Options {
  history: LoadedHistory | null
  snapshot: SessionSnapshot | null
  actionVersion: number
  pause: () => void
  captureViewport: () => SessionSnapshot['checkpoint']['workspace']['viewport']
  download: (range: DateRange, progress?: (value: LoadProgress) => void) => Promise<LoadedHistory>
  restore: (hydration: Hydration, history: LoadedHistory) => void
  fresh: (range: DateRange) => void
}
interface Active {
  id: string; name: string; createdAt: string; record: SessionRecord | null
  history: LoadedHistory | null; historyId: string | null; cacheAttempted: boolean
}
const newActive = (): Active => ({ id: crypto.randomUUID(), name: 'Untitled backtest', createdAt: new Date().toISOString(), record: null, history: null, historyId: null, cacheAttempted: false })
export function useSessionPersistence(options: Options) {
  const [store] = useState(() => new DiskSessionStore())
  const [legacyStore] = useState(() => new SessionStore())
  const [legacySessions, setLegacySessions] = useState<SessionRecord[]>([])
  const [storageLocation, setStorageLocation] = useState<string | null>(null)
  const [migrationWarning, setMigrationWarning] = useState<string | null>(null)
  const active = useRef<Active | null>(null)
  const latest = useRef(options)
  const [diskErrors, setDiskErrors] = useState<DiskSessionStore['listErrors']>([])
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [name, setName] = useState('Untitled backtest')
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [saveStatus, setSaveStatus] = useState<'Saving' | 'Saved' | 'Error'>('Saving')
  const [error, setError] = useState<string | null>(null)
  const [cacheWarning, setCacheWarning] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const conflicted = useRef(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const switching = useRef(false)
  const [repairTarget, setRepairTarget] = useState<{ id: string; name: string } | null>(null)
  const [repairProgress, setRepairProgress] = useState<LoadProgress | null>(null)
  const [cleanupPreview, setCleanupPreview] = useState<CleanupPreview | null>(null)
  const [cleanupResult, setCleanupResult] = useState<CleanupResult | null>(null)
  const preferenceGuard = useRef<PreferenceTabGuard | null>(null)
  const [uiCleanupPreview, setUiCleanupPreview] = useState<PreferenceCleanupPreview | null>(null)
  const [uiCleanupResult, setUiCleanupResult] = useState<PreferenceCleanupResult | null>(null)
  const [preferenceNotice, setPreferenceNotice] = useState<string | null>(null)
  const [awaitingChoice, setAwaitingChoice] = useState(false)
  const [initialized, setInitialized] = useState(false)
  const ready = useRef(false)
  const queue = useRef<AutosaveQueue | null>(null)
  const promptTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const channel = useRef<BroadcastChannel | null>(null)
  useLayoutEffect(() => { latest.current = options }, [options])
  async function refresh() { const rows = await store.list(); setSessions(rows); setDiskErrors(store.listErrors); return rows }
  function report(reason: unknown) {
    setSaveStatus('Error'); setError(storageError(reason))
    if (reason instanceof RevisionConflict) { conflicted.current = true; setConflict(true); latest.current.pause() }
  }
  async function write() {
    if (!ready.current || conflicted.current) return
    const target = active.current, current = latest.current
    if (!target || !current.history || !current.snapshot || busyRef.current) return
    setSaveStatus('Saving')
    try {
      const invalid = accountRiskError(current.snapshot.checkpoint.trading.account) ?? commissionConfigError(current.snapshot.checkpoint.trading.commission)
      if (invalid) throw new Error(`Checkpoint not saved: ${invalid}`)
      if (target.history !== current.history) {
        const history = validatedHistory(current.history)
        target.historyId = await historyFingerprint(history); target.history = current.history; target.cacheAttempted = false
      }
      const presentation = readUi(target.id, 'workspace', target.record?.checkpoint.workspace ?? current.snapshot.checkpoint.workspace, validWorkspace)
      const captured = current.captureViewport()
      const snapshot: SessionSnapshot = { ...current.snapshot, checkpoint: { ...current.snapshot.checkpoint,
        workspace: { ...presentation, viewport: captured?.range ? captured : presentation.viewport },
      } }
      // Publish validated history before a checkpoint can reference it.
      if (!target.cacheAttempted) {
        await store.cacheHistory(target.historyId!, current.history)
        target.cacheAttempted = true
      }
      const record = await store.save({ id: target.id, name: target.name, createdAt: target.createdAt,
        range: { from: current.history.tradingFrom, to: current.history.to }, historyId: target.historyId!, totalCandles: historyCandles(current.history).length }, snapshot, target.record)
      target.record = record
      setSavedAt(record.savedAt); setSaveStatus(latest.current.snapshot === current.snapshot && target.name === record.name ? 'Saved' : 'Saving'); setError(null)
      channel.current?.postMessage({ id: record.id, revision: record.revision })
      await refresh()

    } catch (reason) {
      if (target.record && repairableHistory(reason)) setRepairTarget({ id: target.id, name: target.name })
      report(reason); throw reason
    }
  }
  async function discoverLegacy() {
    try {
      const rows = await legacyStore.list(), pending: SessionRecord[] = []
      for (const row of rows) {
        const receipt = await store.migrationReceipt(row.id)
        if (receipt?.digest !== row.digest) pending.push(row)
      }
      setLegacySessions(pending); setMigrationWarning(null)
      return pending
    } catch (reason) { setMigrationWarning(`Browser migration discovery failed: ${storageError(reason)} Disk sessions remain available. Retry storage to discover browser sessions again.`); return [] }
  }
  async function initialize(live = () => true) {
    try {
      const status = await store.status(), rows = await store.list()
      if (!live()) return
      setStorageLocation(status.directory); setSessions(rows); setDiskErrors(store.listErrors)
      if (active.current) ready.current = true
      if (!active.current) {
        // Browser migration is optional. Its discovery must not block a new
        // setup when there are no authoritative disk sessions to choose from.
        if (rows.length || store.listErrors.length) setAwaitingChoice(true)
        else { active.current = newActive(); ready.current = true; setAwaitingChoice(false) }
      }
      if (!conflicted.current) setError(null)
      setInitialized(true)
      void discoverLegacy()
    } catch (reason) { if (live()) { report(reason); setAwaitingChoice(true) } }
  }
  useEffect(() => {
    let live = true
    queue.current = new AutosaveQueue(write)
    const guard = new PreferenceTabGuard()
    preferenceGuard.current = guard
    void guard.start().catch(() => {}).then(() => { if (live) void initialize(() => live) })

    // Revision checks in the write transaction are authoritative. Broadcasts
    // shorten the time until an active editor sees the conflict.
    if (typeof BroadcastChannel !== 'undefined') {
      channel.current = new BroadcastChannel('forextester-sessions')
      channel.current.onmessage = (event) => {
        const target = active.current
        if (target?.record && event.data?.id === target.id && event.data.revision > target.record.revision) report(new RevisionConflict())
        void refresh().catch(() => {})
      }
    }
    return () => { live = false; guard.stop(); ready.current = false; if (promptTimer.current) clearTimeout(promptTimer.current); promptTimer.current = null; queue.current?.dispose(); channel.current?.close(); channel.current = null }
  }, [store])

  const previous = useRef<{ snapshot: SessionSnapshot | null; action: number } | null>(null)
  useEffect(() => {
    const current = options.snapshot, before = previous.current
    previous.current = { snapshot: current, action: options.actionVersion }
    if (!initialized || awaitingChoice || busy || conflict || !current) return
    const changed = before?.snapshot !== current || before?.action !== options.actionVersion
    const important = !savedAt || !current.checkpoint.replay.playing || before?.action !== options.actionVersion ||
      !before?.snapshot?.checkpoint.replay.started
    if (!changed && savedAt) return
    if (important) {
      setSaveStatus('Saving')
      // A short queue groups metadata keystrokes and paired React updates.
      if (promptTimer.current === null) promptTimer.current = setTimeout(() => { promptTimer.current = null; void queue.current?.flush().catch(() => {}) }, 150)
    }
  }, [options.snapshot, options.actionVersion, initialized, awaitingChoice, busy, conflict])
  useEffect(() => {
    if (!initialized || awaitingChoice) return
    const timer = options.snapshot?.checkpoint.replay.playing ? setInterval(() => { void queue.current?.flush().catch(() => {}) }, 5000) : null
    const hidden = () => { if (document.visibilityState === 'hidden') void queue.current?.flush().catch(() => {}) }
    document.addEventListener('visibilitychange', hidden)
    return () => { if (timer) clearInterval(timer); document.removeEventListener('visibilitychange', hidden) }
  }, [initialized, awaitingChoice, options.snapshot?.checkpoint.replay.playing])

  async function flush() {
    if (conflicted.current) throw new RevisionConflict()
    await queue.current?.flush()
  }
  async function switchWorkspace(id: string | null, range?: DateRange, repair = false) {
    if (switching.current || busyRef.current || !initialized) return false
    switching.current = true; setBusy(true)
    latest.current.pause()
    let recovering = false
    try {
      if (id && repair) {
        busyRef.current = true
        setRepairProgress({ completed: 0, total: 0 })
        await store.repairHistory(id, (range) => latest.current.download(range, setRepairProgress))
        busyRef.current = false
      }
      // A stale tab must be able to reload the authoritative version. Its
      // unsaved state can never be written over the newer revision.
      if (!conflicted.current) await flush()
      busyRef.current = true; setBusy(true)
      if (id) {
        recovering = true
        const result = await store.recover(id)
        const { record } = result
        active.current = { id: record.id, name: record.name, createdAt: record.createdAt, record, history: result.history, historyId: record.historyId, cacheAttempted: true }
        setName(record.name); setSavedAt(record.savedAt); setCacheWarning(result.cacheWarning)
        writeUi(record.id, 'workspace', readUi(record.id, 'workspace', result.checkpoint.workspace, validWorkspace))
        latest.current.restore(result, result.history)
      } else {
        const presentation = readUi(active.current?.id ?? null, 'workspace', defaultWorkspace(), validWorkspace)
        active.current = newActive(); writeUi(active.current.id, 'workspace', presentation); setName(active.current.name); setSavedAt(null); setCacheWarning(null)
        latest.current.fresh(range ?? { from: latest.current.history?.tradingFrom ?? '2024-01-09', to: latest.current.history?.to ?? '2024-01-10' })
      }
      setRepairTarget(null); setRepairProgress(null)
      ready.current = true; setAwaitingChoice(false); conflicted.current = false; setConflict(false); setError(null); setSaveStatus(id ? 'Saved' : 'Saving')
      return true
    } catch (reason) {
      if (id && recovering && repairableHistory(reason)) setRepairTarget({ id, name: sessions.find((record) => record.id === id)?.name ?? 'Saved session' })
      else if (!repair && recovering) setRepairTarget(null)
      report(reason); return false
    }
    finally { busyRef.current = false; switching.current = false; setBusy(false) }
  }
  function editName(value: string) {
    setName(value)
    if (active.current && value.trim()) {
      active.current.name = value.trim()
      void queue.current?.flush().catch(() => {})
    }
  }
  async function rename(record: SessionRecord, value: string) {
    try {
      if (record.id === active.current?.id) { editName(value); return }
      await store.rename(record.id, value, record.revision); await refresh()
      channel.current?.postMessage({ id: record.id, revision: record.revision + 1 })
    } catch (reason) { report(reason) }
  }
  async function remove(record: SessionRecord) {
    if (switching.current || busyRef.current) return
    if (!window.confirm(`Delete “${record.name}” from saved backtests? It cannot be resumed afterward. This cannot be undone in the app.`)) return
    switching.current = true; setBusy(true)
    try {
      if (record.id === active.current?.id) {
        await flush()
        record = active.current.record!
      }
      busyRef.current = true
      await store.delete(record.id, record.revision)
      channel.current?.postMessage({ id: record.id, revision: Number.MAX_SAFE_INTEGER })
      if (record.id === active.current?.id) {
        active.current = newActive(); setName(active.current.name); setSavedAt(null)
        latest.current.fresh(record.range)
      }
      try {
        await preferenceGuard.current!.exclusive(() => removeDeletedUi(record.id, () => legacyStore.list()))
        setPreferenceNotice(null)
      } catch { setPreferenceNotice('Backtest deleted. Its UI preferences were retained because browser storage or other tabs could not be verified. Use Storage maintenance to retry later.') }
      await refresh()
    } catch (reason) { report(reason) }
    finally { busyRef.current = false; switching.current = false; setBusy(false) }
  }
  const uiInventory = {
    disk: async () => {
      const rows = await store.list()
      if (store.listErrors.length) throw new Error('Disk session inventory contains unreadable sessions. UI preferences were kept.')
      return rows
    },
    legacy: () => legacyStore.list(),
    active: () => active.current?.id ?? null,
  }
  async function previewPreferences() {
    if (switching.current || busyRef.current) return
    switching.current = true; setBusy(true); setUiCleanupResult(null)
    try {
      const candidates = await preferenceGuard.current!.exclusive(() => previewUiCleanup(uiInventory))
      setUiCleanupPreview({ candidates, error: null })
    } catch (reason) { setUiCleanupPreview({ candidates: [], error: storageError(reason) }) }
    finally { switching.current = false; setBusy(false) }
  }
  async function cleanupPreferences() {
    if (switching.current || busyRef.current || !uiCleanupPreview?.candidates.length || uiCleanupPreview.error) return
    if (!window.confirm(`Remove ${uiCleanupPreview.candidates.length} unused UI preference entries? Saved backtests and historical data will be kept. Session inventories are checked again before removal.`)) return
    switching.current = true; setBusy(true)
    try { setUiCleanupResult(await preferenceGuard.current!.exclusive(() => removeUnusedUi(uiCleanupPreview.candidates, uiInventory))) }
    catch (reason) { setUiCleanupResult({ removed: 0, error: storageError(reason) }) }
    finally { setUiCleanupPreview(null); switching.current = false; setBusy(false) }
  }
  async function previewCleanup() {
    if (switching.current || busyRef.current) return
    switching.current = true; setBusy(true); setCleanupResult(null)
    try { setCleanupPreview(await store.previewCleanup()) }
    catch (reason) { setCleanupPreview(null); report(reason) }
    finally { switching.current = false; setBusy(false) }
  }
  async function cleanup() {
    if (switching.current || busyRef.current || !cleanupPreview?.safe || !cleanupPreview.candidateFiles) return
    if (!window.confirm(`Remove unused storage files at least seven days old? Preview estimates ${cleanupPreview.candidateFiles} files (${cleanupPreview.reclaimableBytes.toLocaleString('en-US')} bytes). Active sessions are revalidated before deletion. Back up the durable storage directory while the backend is stopped before major maintenance.`)) return
    switching.current = true; setBusy(true)
    try { setCleanupResult(await store.cleanup()); setCleanupPreview(null) }
    catch (reason) { report(reason) }
    finally { switching.current = false; setBusy(false) }
  }
  async function migrate(id: string, asCopy = false) {
    if (busyRef.current) return
    setBusy(true); latest.current.pause()
    try {
      if (!conflicted.current) await flush()
      busyRef.current = true
      const result = await store.migrate(legacyStore, id, (range) => latest.current.download(range), asCopy)
      if (validWorkspace(result.checkpoint.workspace)) writeUi(result.record.id, 'workspace', result.checkpoint.workspace)
      await refresh(); await discoverLegacy(); setError(null)
    } catch (reason) { report(reason) }
    finally { busyRef.current = false; setBusy(false) }
  }
  return { uiCleanupPreview, uiCleanupResult, preferenceNotice, previewPreferences, cleanupPreferences, repairTarget, repairProgress, repair: () => repairTarget && switchWorkspace(repairTarget.id, undefined, true), cleanupPreview, cleanupResult, previewCleanup, cleanup, sessions, diskErrors, legacySessions, storageLocation, migrationWarning, migrate, retry: () => { void initialize() }, name, savedAt, saveStatus, error, cacheWarning, conflict, busy, initialized, awaitingChoice,
    flush, activeId: active.current?.id ?? null, editName, rename, remove, resume: (id: string) => switchWorkspace(id),
    fresh: (range?: DateRange) => switchWorkspace(null, range), save: () => { if (active.current) active.current.cacheAttempted = false; void flush().catch(report) } }
}
