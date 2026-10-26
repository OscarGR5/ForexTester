import { useLayoutEffect, useRef, useState } from 'react'
import type { SessionRecord } from './sessionTypes'
import type { useSessionPersistence } from './useSessionPersistence'

type Sessions = ReturnType<typeof useSessionPersistence>
const time = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? `${new Date(value).toISOString().slice(0, 19).replace('T', ' ')} UTC` : 'No successful save yet'
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
const readable = (value: unknown, fallback: string) => typeof value === 'string' ? value : fallback
function SavedSession({ record, sessions, startup, onRemoveFinished }: { record: SessionRecord; sessions: Sessions; startup: boolean; onRemoveFinished: () => void }) {
  const start = count(record.checkpoint?.replay?.startIndex), total = count(record.totalCandles), index = count(record.checkpoint?.replay?.index)
  const progress = record.checkpoint?.replay?.started && start !== null && index !== null ? Math.max(0, index + 1 - start) : 0
  const available = start !== null && total !== null ? Math.max(0, total - start) : 'Unknown'
  const percent = typeof available === 'number' && available > 0 ? Math.min(100, Math.round(progress / available * 100)) : 0
  const label = readable(record.name, 'Unreadable session')
  const [name, setName] = useState(label)
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [working, setWorking] = useState(false)
  const nameButton = useRef<HTMLButtonElement>(null), nameInput = useRef<HTMLInputElement>(null)
  const deleteButton = useRef<HTMLButtonElement>(null), cancelDelete = useRef<HTMLButtonElement>(null)
  const restore = useRef<'name' | 'delete' | null>(null)
  useLayoutEffect(() => {
    if (editing) { nameInput.current?.focus(); nameInput.current?.select() }
    else if (deleting) cancelDelete.current?.focus()
    else if (restore.current) {
      (restore.current === 'name' ? nameButton : deleteButton).current?.focus()
      restore.current = null
    }
  }, [editing, deleting])
  const cancelRename = () => { restore.current = 'name'; setEditing(false); setName(label) }
  const rename = async () => {
    if (working || sessions.busy || !name.trim() || name.trim() === label) return
    setWorking(true)
    try { await sessions.rename(record, name.trim()); restore.current = 'name'; setEditing(false) }
    finally { setWorking(false) }
  }
  const remove = async () => {
    if (working || sessions.busy) return
    setWorking(true)
    try {
      await sessions.remove(record, true)
      if (deleteButton.current?.isConnected) { restore.current = 'delete'; setDeleting(false) }
      onRemoveFinished()
    } finally { setWorking(false) }
  }
  const disabled = sessions.busy || working
  return <li className="saved-session">
    <div className="saved-session-info">
      {editing ? <form className="session-rename" aria-label={`Rename backtest ${label}`} onSubmit={event => { event.preventDefault(); void rename() }} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!working) cancelRename() }
      }}>
        <input ref={nameInput} maxLength={200} aria-label={`Rename session ${record.id}`} value={name} disabled={disabled} onChange={event => setName(event.target.value)} />
        <button type="submit" disabled={disabled || !name.trim() || name.trim() === label}>Confirm rename</button>
        <button type="button" disabled={working} onClick={cancelRename}>Cancel rename</button>
        {!name.trim() && <span className="form-error" role="status">Name cannot be blank.</span>}
      </form> : <button ref={nameButton} type="button" className="saved-session-name" aria-label={`Rename backtest ${label}`} title="Click to rename" disabled={disabled || deleting} onClick={() => { setName(label); setEditing(true) }}>{label}</button>}
      <span>Historical period: {readable(record.range?.from, 'Unknown range')} → {readable(record.range?.to, 'Unknown range')} UTC (end exclusive)</span>
      <span>Status: {record.checkpoint?.lifecycle === 'finished' ? 'finished' : readable(record.status, 'Unknown status')} · Replay progress: {percent}%</span>
      <span>Saved {record.savedAt ? time(record.savedAt) : 'Unknown'} · {progress} / {available} candles · {count(record.completedSetups) ?? 'Unknown'} completed setups</span>
      {deleting && <div className="session-delete-confirmation" role="group" aria-label="Delete backtest confirmation" onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!working) { restore.current = 'delete'; setDeleting(false) } }
      }}>
        <p>Delete “{label}” from local storage on this computer? This removes the saved backtest and cannot be undone in the app.</p>
        <button type="button" className="danger-action" disabled={disabled} onClick={() => void remove()}>Confirm delete</button>
        <button ref={cancelDelete} type="button" disabled={working} onClick={() => { restore.current = 'delete'; setDeleting(false) }}>Cancel delete</button>
      </div>}
    </div>
    <div className="session-actions">
      <button type="button" disabled={disabled || editing || deleting} onClick={() => void sessions.resume(record.id)}>{startup ? 'Resume backtest' : 'Resume session'}</button>
      <button ref={deleteButton} type="button" className="session-delete" aria-label={`Delete backtest ${label}`} title={`Delete backtest ${label}`} disabled={disabled || editing || deleting} onClick={() => setDeleting(true)}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></svg>
      </button>
    </div>
  </li>
}

export function SessionControls({ sessions, range, timestamp, startup = false }: { sessions: Sessions; range: { from: string; to: string }; timestamp: number | null; startup?: boolean }) {
  const [manage, setManage] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const controls = useRef<HTMLElement>(null)
  const [deleted, setDeleted] = useState<{ id: string; index: number } | null>(null)
  useLayoutEffect(() => {
    if (!deleted || sessions.busy) return
    if (!sessions.sessions.some(record => record.id === deleted.id)) {
      const names = controls.current?.querySelectorAll<HTMLButtonElement>('.saved-session-name')
      const target = names?.[Math.min(deleted.index, names.length - 1)]
        ?? controls.current?.querySelector<HTMLButtonElement>('.startup-new button, .session-heading button')
      target?.focus()
    }
    setDeleted(null)
  }, [deleted, sessions.busy, sessions.sessions])
  useLayoutEffect(() => { if (startup) heading.current?.focus() }, [startup])
  return <section ref={controls} className="session-controls" aria-label="Backtest sessions" aria-busy={sessions.busy}>
    {startup ? <div className="startup-heading"><h2 ref={heading} tabIndex={-1}>Choose a backtest</h2><p>Resume a saved backtest, or start a new one.</p></div> : <><div className="session-heading">
      <label>Session name<input maxLength={200} aria-label="Current session name" value={sessions.name} disabled={!sessions.initialized || sessions.awaitingChoice || sessions.busy || sessions.conflict}
        onChange={(event) => sessions.editName(event.target.value)} /></label>
      <div className="session-actions">
        <button type="button" disabled={sessions.busy || !sessions.initialized} onClick={() => void sessions.fresh()}>New session</button>
        <button type="button" disabled={sessions.busy || !sessions.sessions.length} aria-expanded={manage || sessions.awaitingChoice} aria-controls="saved-sessions" onClick={() => setManage(!manage)}>Resume / Manage sessions</button>
        <button type="button" disabled={sessions.busy || sessions.awaitingChoice || sessions.conflict || !sessions.initialized} onClick={sessions.save}>Save now</button>
      </div>
    </div>
    <p className="session-status" role="status"><strong>{sessions.busy ? 'Storage operation in progress…' : sessions.awaitingChoice ? 'Choose a saved session or start a new one.' : sessions.saveStatus}</strong>
      <span>Last successful save: {time(sessions.savedAt)}</span>
      <span>{range.from} → {range.to} UTC{timestamp !== null ? ` · Replay ${time(new Date(timestamp).toISOString())}` : ' · Replay not started'}</span>
    </p>
    </>}
    {!startup && <p className="chart-note storage-location">Storage: {sessions.storageLocation ?? 'Connecting to local backend…'}</p>}
    {sessions.preferenceNotice && <p role="status">{sessions.preferenceNotice}</p>}
    {sessions.error && <p className="form-error" role="alert">{sessions.error}</p>}
    {sessions.error && <button type="button" disabled={sessions.busy} onClick={sessions.retry}>Retry storage connection</button>}
    {sessions.repairTarget && <div aria-label="Historical data repair">
      <p>“{sessions.repairTarget.name}” needs its original historical data. Repair reads the installed local archive and requires an exact fingerprint match. Legacy sessions need their original history object from backup. Trading records are preserved.</p>
      <button type="button" disabled={sessions.busy} onClick={() => void sessions.repair()}>Repair historical data</button>
      {sessions.repairProgress && <p role="status">{sessions.busy ? 'Repairing historical data' : 'Last repair read'}: {sessions.repairProgress.completed} / {sessions.repairProgress.total} chunks</p>}
    </div>}
    {sessions.migrationWarning && <p className="coverage-warning" role="status">{sessions.migrationWarning}</p>}
    {sessions.cacheWarning && <p className="coverage-warning" role="status">{sessions.cacheWarning}</p>}
    {!!sessions.diskErrors.length && <section aria-label="Unreadable disk sessions">{sessions.diskErrors.map((problem) => <div key={problem.id}>
      <p className="form-error" role="alert">{problem.id}: {problem.error}</p>
      <button type="button" disabled={sessions.busy} onClick={() => void sessions.resume(problem.id)}>Retry recovery</button>{' '}
      {problem.revision !== null && <button type="button" disabled={sessions.busy} onClick={() => void sessions.remove({ id: problem.id, name: 'Unreadable disk session', revision: problem.revision } as SessionRecord)}>Delete unreadable session</button>}
    </div>)}</section>}
    {(manage || sessions.awaitingChoice) && <div id="saved-sessions">
      <h2>Saved backtests</h2>
      {!sessions.sessions.length ? <p>No saved sessions on disk.</p> : <ul className="saved-sessions">{sessions.sessions.map((record, index) => <SavedSession key={record.id} record={record} sessions={sessions} startup={startup} onRemoveFinished={() => setDeleted({ id: record.id, index })} />)}</ul>}
    </div>}
    {startup && <div className="startup-new"><button type="button" disabled={sessions.busy || !sessions.initialized} onClick={() => void sessions.fresh()}>New backtest</button><span>Saved backtests stay available.</span></div>}
    {!!sessions.legacySessions.length && <details className="legacy-migration" open={!startup}><summary>Browser sessions to migrate</summary><section aria-label="Import browser sessions">
      <p>These backtests are still in this browser’s IndexedDB. Import verifies their checkpoint, equity and history before saving them on disk. Browser originals are retained.</p>
      <ul>{sessions.legacySessions.map((record) => <li key={record.id}><strong>{readable(record.name, 'Unreadable browser session')}</strong>{' '}
        <button type="button" disabled={sessions.busy || !sessions.initialized} onClick={() => void sessions.migrate(record.id)}>Import to disk</button>{' '}
        <button type="button" disabled={sessions.busy || !sessions.initialized} onClick={() => void sessions.migrate(record.id, true)}>Import as separate session</button>
      </li>)}</ul>
    </section></details>}
    <details className="storage-maintenance">
      <summary>Storage maintenance</summary>
      <p>Remove unused chart and display preferences from this browser.</p>
      <button type="button" disabled={sessions.busy || !sessions.initialized} onClick={() => void sessions.previewPreferences()}>Clean up unused UI preferences</button>
      {sessions.uiCleanupPreview && <div role="status">
        {sessions.uiCleanupPreview.error ? <p className="form-error">{sessions.uiCleanupPreview.error}</p> : <>
          <p>{sessions.uiCleanupPreview.candidates.length} unused UI preference entries safe to remove.</p>
          <button type="button" disabled={sessions.busy || !sessions.uiCleanupPreview.candidates.length} onClick={() => void sessions.cleanupPreferences()}>Confirm UI preference cleanup</button>
        </>}
      </div>}
      {sessions.uiCleanupResult && <div role="status"><p>Removed {sessions.uiCleanupResult.removed} UI preference entries.</p>{sessions.uiCleanupResult.error && <p className="form-error">{sessions.uiCleanupResult.error}</p>}</div>}
      <p className="chart-note">Unused files become eligible after seven days. Back up the durable storage directory while the backend is stopped before major maintenance.</p>
      <button type="button" disabled={sessions.busy || !sessions.initialized} onClick={() => void sessions.previewCleanup()}>Preview cleanup</button>
      {sessions.cleanupPreview && <div role="status">
        {sessions.cleanupPreview.safe ? <>
          <p>{sessions.cleanupPreview.candidateFiles} eligible files · {sessions.cleanupPreview.reclaimableBytes.toLocaleString('en-US')} bytes reclaimable</p>
          <p>{Object.entries(sessions.cleanupPreview.categories).map(([name, value]) => `${name}: ${value.files} files (${value.bytes.toLocaleString('en-US')} bytes)`).join(' · ')}</p>
          <button type="button" disabled={sessions.busy || !sessions.cleanupPreview.candidateFiles} onClick={() => void sessions.cleanup()}>Clean up unused files</button>
        </> : <p className="form-error">{sessions.cleanupPreview.error}</p>}
      </div>}
      {sessions.cleanupResult && <div role="status">
        {sessions.cleanupResult.safe ? <p>Removed {sessions.cleanupResult.removedFiles} files · Reclaimed {sessions.cleanupResult.reclaimedBytes.toLocaleString('en-US')} bytes · {sessions.cleanupResult.remainingFiles} eligible files remain</p> : <p className="form-error">{sessions.cleanupResult.error}</p>}
        {!!sessions.cleanupResult.failures.length && <><p>Some removals could not be confirmed. Preview and retry cleanup.</p><ul>{sessions.cleanupResult.failures.map((failure) => <li key={failure.file}>{failure.file}: {failure.error}</li>)}</ul></>}
      </div>}
    </details>
    {startup && <p className="chart-note storage-location">Saved on this computer · {sessions.storageLocation ?? 'Connecting to local backend…'}</p>}
    {!startup && <p className="chart-note">Saved on this computer through the local backend. Playback checkpoints save about every 5 seconds; only a successful commit is recoverable. Export CSV for a separate journal copy.</p>}
  </section>
}
