import { useEffect, useState } from 'react'
import { type CacheCalendar, cachedPreset, formatUtcDate } from './cacheCalendar'
import { shiftDate } from './workflow'
import type { DateRange } from './history'

export function HistoryTimeline({ calendar, range, disabled, onChange, onEndChange }: {
  calendar: CacheCalendar; range: DateRange; disabled: boolean; onChange: (range: DateRange) => void; onEndChange: () => void
}) {
  const [windowFrom, setWindowFrom] = useState(shiftDate(range.from, -30))
  useEffect(() => { if (range.from < windowFrom || range.to > shiftDate(windowFrom, 120)) setWindowFrom(shiftDate(range.from, -15)) }, [range.from, range.to])
  const offset = (date: string) => Number.isFinite(Date.parse(date)) ? (Date.parse(date) - Date.parse(windowFrom)) / 86400000 : 0
  const entries = new Map(calendar.days.map(day => [day.date, day]))
  const months = [...new Set(calendar.days.map(day => day.date.slice(0, 7)))]
  const move = (handle: 'from' | 'to', value: number) => {
    const date = shiftDate(windowFrom, value)
    if (handle === 'from') onChange({ from: date, to: range.to <= date ? shiftDate(date, 1) : offset(range.to) - value > 90 ? shiftDate(date, 90) : range.to })
    else { onEndChange(); const to = shiftDate(date, 1); onChange({ from: range.from >= to ? date : (Date.parse(to) - Date.parse(range.from)) / 86400000 > 90 ? shiftDate(to, -90) : range.from, to }) }
  }
  return <div className="history-timeline">
    <div className="timeline-navigation"><button type="button" disabled={disabled || !!calendar.from && windowFrom <= calendar.from} aria-label="Earlier historical period" onClick={() => setWindowFrom(shiftDate(windowFrom, -90))}>Earlier</button>
      <label>Browse archive<select aria-label="Browse cached archive" disabled={disabled || !months.length} value={windowFrom.slice(0, 7)} onChange={event => setWindowFrom(`${event.target.value}-01`)}><option value={windowFrom.slice(0, 7)}>{formatUtcDate(windowFrom)}</option>{months.filter(month => month !== windowFrom.slice(0, 7)).map(month => <option key={month} value={month}>{formatUtcDate(`${month}-01`)}</option>)}</select></label>
      <button type="button" disabled={disabled || !!calendar.to && shiftDate(windowFrom, 120) >= calendar.to} aria-label="Later historical period" onClick={() => setWindowFrom(shiftDate(windowFrom, 90))}>Later</button></div>
    <div className="selected-dates" aria-live="polite"><div><span>From</span><strong>{formatUtcDate(range.from)}</strong></div><div><span>Through</span><strong>{formatUtcDate(shiftDate(range.to, -1))}</strong></div></div>
    <div className="timeline-track">
      <div className="timeline-days" aria-hidden="true">{Array.from({ length: 120 }, (_, index) => {
        const date = shiftDate(windowFrom, index), day = entries.get(date)
        return <span key={date} title={`${formatUtcDate(date)}: ${day?.status === 'cached' ? `${day.observations} M1 observations; ${1440-day.observations} minutes without observations` : day?.status === 'gap' ? 'no M1 observations in the source' : 'outside verified local history'}`} className={`${day?.status === 'cached' ? 'cached' : day?.status === 'invalid' ? 'invalid' : 'uncached'}${date >= range.from && date < range.to ? ' selected' : ''}`}/>
      })}</div>
      <input aria-label="Historical start date" aria-valuetext={formatUtcDate(range.from)} type="range" min="0" max="119" value={Math.max(0, Math.min(119, offset(range.from)))} disabled={disabled} onChange={event => move('from', Number(event.target.value))}/>
      <input aria-label="Historical end date" aria-valuetext={formatUtcDate(shiftDate(range.to, -1))} type="range" min="0" max="119" value={Math.max(0, Math.min(119, offset(range.to) - 1))} disabled={disabled} onChange={event => move('to', Number(event.target.value))}/>
    </div>
    <div className="timeline-scale"><span>{formatUtcDate(windowFrom)}</span><span>{formatUtcDate(shiftDate(windowFrom, 119))}</span></div>
    <p className="timeline-legend"><span>M1 observations available</span><span>No M1 observations</span></p>
  </div>
}
export { cachedPreset }
