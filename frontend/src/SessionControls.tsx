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
      <span>{readable(record.range?.from, 'Unknown range')} → {readable(record.range?.to, 'Unknown range')} UTC · {readable(record.status, 'Unknown status')}</span>
      <span>Saved {record.savedAt ? time(record.savedAt) : 'Unknown'} · {progress} / {available} candles · {count(record.completedSetups) ?? 'Unknown'} completed setups</span>
    </div>
    <div className="session-actions">
      <button type="button" disabled={sessions.busy} onClick={() => void sessions.resume(record.id)}>Resume session</button>
      <label>Session name<input aria-label={`Rename session ${record.id}`} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <button type="button" disabled={sessions.busy || !name.trim() || name.trim() === record.name} onClick={() => void sessions.rename(record, name)}>Rename</button>
      <button type="button" disabled={sessions.busy} onClick={() => void sessions.remove(record)}>Delete</button>
    </div>
  </li>
}
export function SessionControls({ sessions, range, timestamp }: { sessions: Sessions; range: { from: string; to: string }; timestamp: number | null }) {
  const [manage, setManage] = useState(false)
  return <section className="session-controls" aria-label="Backtest sessions" aria-busy={sessions.busy}>
    <div className="session-heading">
      <label>Session name<input aria-label="Current session name" value={sessions.name} disabled={!sessions.initialized || sessions.awaitingChoice || sessions.busy || sessions.conflict}
        onChange={(event) => sessions.editName(event.target.value)} /></label>
      <div className="session-actions">
        <button type="button" disabled={sessions.busy || !sessions.initialized} onClick={() => void sessions.fresh()}>New session</button>
        <button type="button" disabled={sessions.busy || !sessions.sessions.length} aria-expanded={manage || sessions.awaitingChoice} aria-controls="saved-sessions" onClick={() => setManage(!manage)}>Resume / Manage sessions</button>
        <button type="button" disabled={sessions.busy || sessions.awaitingChoice || sessions.conflict || !sessions.initialized} onClick={sessions.save}>Save now</button>
      </div>
    </div>
    <p className="session-status" role="status"><strong>{sessions.busy ? 'Recovering session…' : sessions.awaitingChoice ? 'Choose a saved session or start a new one.' : sessions.saveStatus}</strong>
      <span>Last successful save: {time(sessions.savedAt)}</span>
      <span>{range.from} → {range.to} UTC{timestamp !== null ? ` · Replay ${time(new Date(timestamp).toISOString())}` : ' · Replay not started'}</span>
    </p>
    {sessions.error && <p className="form-error" role="alert">{sessions.error}</p>}
    {sessions.cacheWarning && <p className="coverage-warning" role="status">{sessions.cacheWarning}</p>}
    {(manage || sessions.awaitingChoice) && <div id="saved-sessions">
      <h2>Saved backtests</h2>
      {!sessions.sessions.length ? <p>No saved sessions in this browser profile.</p> : <ul className="saved-sessions">{sessions.sessions.map((record) => <SavedSession key={`${record.id}-${record.name}`} record={record} sessions={sessions} />)}</ul>}
    </div>}
    <p className="chart-note">Local to this browser and origin. Playback checkpoints save about every 5 seconds; only a successful commit is recoverable. Export CSV for a separate journal copy.</p>
  </section>
}
