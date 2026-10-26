import { type Candle, type DateRange, type TradeCandle } from './history.js'
import { shiftDate } from './workflow.js'

export interface CalendarDay { date: string; status: 'cached' | 'invalid' | 'gap'; observations: number; h4: Candle[] }
export interface CacheCalendar { days: CalendarDay[]; symbol?: string; datasetId?: string; from?: string; to?: string; firstTimestamp?: number; lastTimestamp?: number; priceBasis?: 'mid' }
export const formatUtcDate = (value: string | number) => !Number.isFinite(new Date(value).getTime()) ? 'Choose date' : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(value))
const H4 = 14_400_000
export const WARMUP_REQUIRED = 78

// Count observed, completed buckets only, within the current contiguous contract segment.
// Calendar H4 summaries and full M1 data share this scan. No future price is consulted.
export function automaticReplayStart(candles: readonly Candle[], range: DateRange) {
  let completed = 0, bucket = -Infinity, contract: number | undefined
  const from = Date.parse(range.from), to = Date.parse(range.to)
  for (let index = 0; index < candles.length; index++) {
    const candle = candles[index], id = (candle as Partial<TradeCandle>).instrumentId
    const next = Math.floor(candle.timestamp / H4) * H4
    if (index === 0 || id !== contract) { completed = 0; bucket = next; contract = id }
    else if (next !== bucket) { completed++; bucket = next }
    if (candle.timestamp >= to) break
    if (candle.timestamp >= from && completed >= WARMUP_REQUIRED) return { index, timestamp: candle.timestamp, count: completed, required: WARMUP_REQUIRED }
  }
  return null
}
export function rangeCoverage(calendar: CacheCalendar, range: DateRange) {
  const length = (Date.parse(range.to) - Date.parse(range.from)) / 86400000
  if (!Number.isFinite(length) || length < 1 || length > 90) return { missing: 0, replay: null }
  const days = new Map(calendar.days.map(day => [day.date, day]))
  let missing = 0
  const candles: Candle[] = []
  for (let date = shiftDate(range.from, -30); date && date < range.to; date = shiftDate(date, 1)) {
    const entry = days.get(date)
    if (!entry || entry.status === 'invalid' || calendar.firstTimestamp !== undefined && Date.parse(date) < Math.ceil(calendar.firstTimestamp / 86400000) * 86400000) missing++
    else candles.push(...entry.h4)
  }
  return { missing, replay: missing ? null : automaticReplayStart(candles, range) }
}
export function cachedPreset(calendar: CacheCalendar, days: number, selectedEnd?: string): DateRange | null {
  const ends = calendar.days.filter(day => day.status === 'cached').map(day => shiftDate(day.date, 1)).reverse()
  if (selectedEnd) ends.unshift(selectedEnd)
  for (const to of [...new Set(ends)]) {
    const range = { from: shiftDate(to, -days), to }
    const coverage = rangeCoverage(calendar, range)
    if (!coverage.missing && coverage.replay) return range
  }
  return null
}
