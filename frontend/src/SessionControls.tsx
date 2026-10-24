import { providerLabel } from './history'
import { useState } from 'react'
import type { SessionRecord } from './sessionTypes'
import type { useSessionPersistence } from './useSessionPersistence'

type Sessions = ReturnType<typeof useSessionPersistence>
const time = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? `${new Date(value).toISOString().slice(0, 19).replace('T', ' ')} UTC` : 'No successful save yet'
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
const readable = (value: unknown, fallback: string) => typeof value === 'string' ? value : fallback
function SavedSession({ record, sessions }: { record: SessionRecord; sessions: Sessions }) {
  const start = count(record.checkpoint?.replay?.startIndex), total = count(record.totalCandles), index = count(record.checkpoint?.replay?.index)
  const progress = record.checkpoint?.replay?.started && start !== null && index !== null ? Math.max(0, index + 1 - start) : 0
  const available = start !== null && total !== null ? Math.max(0, total - start) : 'Unknown'
  const [name, setName] = useState(typeof record.name === 'string' ? record.name : 'Unreadable session')
  return <li className="saved-session">
    <div className="saved-session-info"><strong>{readable(record.name, 'Unreadable session')}</strong>
      <span>{providerLabel(record.provenance?.provider)} · {readable(record.range?.from, 'Unknown range')} → {readable(record.range?.to, 'Unknown range')} UTC · {readable(record.status, 'Unknown status')}</span>
      <span>Saved {record.savedAt ? time(record.savedAt) : 'Unknown'} · {progress} / {available} candles · {count(record.completedSetups) ?? 'Unknown'} completed setups</span>
    </div>
    <div className="session-actions">
      <button type="button" disabled={sessions.busy} onClick={() => void sessions.resume(record.id)}>Resume session</button>
      <label>Session name<input maxLength={200} aria-label={`Rename session ${record.id}`} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <button type="button" disabled={sessions.busy || !name.trim() || name.trim() === record.name} onClick={() => void sessions.rename(record, name)}>Rename</button>
      <button type="button" disabled={sessions.busy} onClick={() => void sessions.remove(record)}>Delete</button>
    </div>
  </li>
}
export function SessionControls({ sessions, range, timestamp }: { sessions: Sessions; range: { from: string; to: string }; timestamp: number | null }) {
  const [manage, setManage] = useState(false)
  return <section className="session-controls" aria-label="Backtest sessions" aria-busy={sessions.busy}>
    <div className="session-heading">
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
    <p className="chart-note">Storage: {sessions.storageLocation ?? 'Connecting to local backend…'}</p>
    {sessions.error && <p className="form-error" role="alert">{sessions.error}</p>}
    {sessions.error && <button type="button" disabled={sessions.busy} onClick={sessions.retry}>Retry storage connection</button>}
    {sessions.repairTarget && <div aria-label="Historical data repair">
      <p>“{sessions.repairTarget.name}” needs its original historical data. Repair downloads the saved range and 30-day pre-roll and requires an exact fingerprint match. Trading records are preserved.</p>
      <button type="button" disabled={sessions.busy} onClick={() => void sessions.repair()}>Repair historical data</button>
      {sessions.repairProgress && <p role="status">{sessions.busy ? 'Repairing historical data' : 'Last repair download'}: {sessions.repairProgress.completed} / {sessions.repairProgress.total} chunks</p>}
    </div>}
    {sessions.migrationWarning && <p className="coverage-warning" role="status">{sessions.migrationWarning}</p>}
    {sessions.cacheWarning && <p className="coverage-warning" role="status">{sessions.cacheWarning}</p>}
    {!!sessions.diskErrors.length && <section aria-label="Unreadable disk sessions">{sessions.diskErrors.map((problem) => <div key={problem.id}>
      <p className="form-error" role="alert">{problem.id}: {problem.error}</p>
      <button type="button" disabled={sessions.busy} onClick={() => void sessions.resume(problem.id)}>Retry recovery</button>{' '}
      {problem.revision !== null && <button type="button" disabled={sessions.busy} onClick={() => void sessions.remove({ id: problem.id, name: 'Unreadable disk session', revision: problem.revision } as SessionRecord)}>Delete unreadable session</button>}
    </div>)}</section>}
    {!!sessions.legacySessions.length && <section aria-label="Import browser sessions"><h2>Browser sessions to migrate</h2>
      <p>These backtests are still in this browser’s IndexedDB. Import verifies their checkpoint, equity and history before saving them on disk. Browser originals are retained.</p>
      <ul>{sessions.legacySessions.map((record) => <li key={record.id}><strong>{readable(record.name, 'Unreadable browser session')}</strong>{' '}
        <button type="button" disabled={sessions.busy || !sessions.initialized} onClick={() => void sessions.migrate(record.id)}>Import to disk</button>{' '}
        <button type="button" disabled={sessions.busy || !sessions.initialized} onClick={() => void sessions.migrate(record.id, true)}>Import as separate session</button>
      </li>)}</ul>
    </section>}
    {(manage || sessions.awaitingChoice) && <div id="saved-sessions">
      <h2>Saved backtests</h2>
      {!sessions.sessions.length ? <p>No saved sessions on disk.</p> : <ul className="saved-sessions">{sessions.sessions.map((record) => <SavedSession key={`${record.id}-${record.name}`} record={record} sessions={sessions} />)}</ul>}
    </div>}
    <details>
      <summary>Storage maintenance</summary>
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
    <p className="chart-note">Saved on this computer through the local backend. Playback checkpoints save about every 5 seconds; only a successful commit is recoverable. Export CSV for a separate journal copy.</p>
  </section>
}
