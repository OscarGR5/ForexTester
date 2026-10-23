import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { accountRiskError } from './risk'
import { commissionConfigError } from './commissions'
import { AutosaveQueue } from './autosave'
import { historyFingerprint, validatedHistory } from './sessionCodec'
import { DiskSessionStore } from './diskSessionStore'
import { writeUi, readUi, defaultWorkspace, validWorkspace } from './uiPreferences'
import { RevisionConflict, SessionStore, storageError } from './sessionStore'
import type { DateRange } from './history'
import type { LoadedHistory } from './historyLoader'
import type { Hydration, SessionRecord, SessionSnapshot } from './sessionTypes'

interface Options {
  history: LoadedHistory | null
  snapshot: SessionSnapshot | null
  actionVersion: number
  pause: () => void
  captureViewport: () => SessionSnapshot['checkpoint']['workspace']['viewport']
  download: (range: DateRange) => Promise<LoadedHistory>
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
      const snapshot = current.snapshot
      // Publish validated history before a checkpoint can reference it.
      if (!target.cacheAttempted) {
        await store.cacheHistory(target.historyId!, current.history)
        target.cacheAttempted = true
      }
      const record = await store.save({ id: target.id, name: target.name, createdAt: target.createdAt,
        range: { from: current.history.tradingFrom, to: current.history.to }, historyId: target.historyId!, totalCandles: current.history.bid.length }, snapshot, target.record)
      target.record = record
      setSavedAt(record.savedAt); setSaveStatus(latest.current.snapshot === snapshot && target.name === record.name ? 'Saved' : 'Saving'); setError(null)
      channel.current?.postMessage({ id: record.id, revision: record.revision })
      await refresh()

    } catch (reason) { report(reason); throw reason }
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
      const legacy = await discoverLegacy()
      if (!live()) return
      if (!active.current) {
        if (rows.length || legacy.length || store.listErrors.length) setAwaitingChoice(true)
        else { active.current = newActive(); ready.current = true; setAwaitingChoice(false) }
      }
      if (!conflicted.current) setError(null)
      setInitialized(true)
    } catch (reason) { if (live()) { report(reason); setAwaitingChoice(true) } }
  }
  useEffect(() => {
    let live = true
    queue.current = new AutosaveQueue(write)
    void initialize(() => live)

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
    return () => { live = false; ready.current = false; if (promptTimer.current) clearTimeout(promptTimer.current); promptTimer.current = null; queue.current?.dispose(); channel.current?.close(); channel.current = null }
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
  async function switchWorkspace(id: string | null, range?: DateRange) {
    if (busyRef.current || !initialized) return
    setBusy(true)
    latest.current.pause()
    try {
      // A stale tab must be able to reload the authoritative version. Its
      // unsaved state can never be written over the newer revision.
      if (!conflicted.current) await flush()
      busyRef.current = true; setBusy(true)
      if (id) {
        const result = await store.recover(id, (range) => latest.current.download(range))
        const { record } = result
        active.current = { id: record.id, name: record.name, createdAt: record.createdAt, record, history: result.history, historyId: record.historyId, cacheAttempted: true }
        setName(record.name); setSavedAt(record.savedAt); setCacheWarning(result.cacheWarning)
        latest.current.restore(result, result.history)
      } else {
        const presentation = readUi(active.current?.id ?? null, 'workspace', defaultWorkspace(), validWorkspace)
        active.current = newActive(); writeUi(active.current.id, 'workspace', presentation); setName(active.current.name); setSavedAt(null); setCacheWarning(null)
        latest.current.fresh(range ?? { from: latest.current.history?.tradingFrom ?? '2024-01-09', to: latest.current.history?.to ?? '2024-01-10' })
      }
      ready.current = true; setAwaitingChoice(false); conflicted.current = false; setConflict(false); setError(null); setSaveStatus(id ? 'Saved' : 'Saving')
    } catch (reason) { report(reason) }
    finally { busyRef.current = false; setBusy(false) }
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
    if (!window.confirm(`Delete “${record.name}” from saved backtests? It cannot be resumed afterward. This cannot be undone in the app.`)) return
    try {
      if (record.id === active.current?.id) {
        await flush()
        record = active.current.record!
      }
      await store.delete(record.id, record.revision)
      channel.current?.postMessage({ id: record.id, revision: Number.MAX_SAFE_INTEGER })
      if (record.id === active.current?.id) {
        active.current = newActive(); setName(active.current.name); setSavedAt(null)
        latest.current.fresh(record.range)
      }
      await refresh()
    } catch (reason) { report(reason) }
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
  return { sessions, diskErrors, legacySessions, storageLocation, migrationWarning, migrate, retry: () => { void initialize() }, name, savedAt, saveStatus, error, cacheWarning, conflict, busy, initialized, awaitingChoice,
    activeId: active.current?.id ?? null, editName, rename, remove, resume: (id: string) => switchWorkspace(id),
    fresh: (range?: DateRange) => switchWorkspace(null, range), save: () => { if (active.current) active.current.cacheAttempted = false; void flush().catch(report) } }
}
