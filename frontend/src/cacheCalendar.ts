import { MAX_BACKTEST_DAYS, TIMEFRAME_MS, aggregateBidCandles, type Candle, type DateRange, type Timeframe, type TradeCandle } from './history.js'
import { shiftDate } from './workflow.js'

export interface CalendarDay { date: string; status: 'cached' | 'invalid' | 'gap'; observations: number; h4: Candle[] }
export interface CacheCalendar { days: CalendarDay[]; symbol?: string; datasetId?: string; from?: string; to?: string; firstTimestamp?: number; lastTimestamp?: number; priceBasis?: 'mid' }
export interface WarmupRequirement { timeframe: Timeframe; periods: number }
export interface WarmupCheck extends WarmupRequirement { count: number }
export interface ReplayReadiness {
  index: number
  timestamp: number
  count: number
  required: number
  timeframe: Timeframe
  warmupFrom: string
  checks: WarmupCheck[]
}

export const DEFAULT_WARMUP_REQUIREMENTS: readonly WarmupRequirement[] = [{ timeframe: 'D1', periods: 78 }]
export const formatUtcDate = (value: string | number) => !Number.isFinite(new Date(value).getTime()) ? 'Choose date' : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(value))

interface PreparedCalendar {
  candles: Candle[]
  days: Map<string, CalendarDay>
  bars: Map<Timeframe, Candle[]>
  segmentStarts: Map<Timeframe, number[]>
}
const preparedCalendars = new WeakMap<CacheCalendar, Map<string, PreparedCalendar>>()

function requirementKey(requirements: readonly WarmupRequirement[]) {
  return [...new Set(requirements.map(item => item.timeframe))].sort().join(',')
}
function segmentStarts(bars: readonly Candle[]) {
  const starts: number[] = []
  for (let index = 0, start = 0; index < bars.length; index++) {
    if (index && (bars[index] as Partial<TradeCandle>).instrumentId !== (bars[index - 1] as Partial<TradeCandle>).instrumentId) start = index
    starts.push(start)
  }
  return starts
}
function prepareCalendar(calendar: CacheCalendar, requirements: readonly WarmupRequirement[]): PreparedCalendar {
  const key = requirementKey(requirements)
  const cached = preparedCalendars.get(calendar)?.get(key)
  if (cached) return cached
  const candles = calendar.days.filter(day => day.status !== 'invalid').flatMap(day => day.h4)
  const bars = new Map<Timeframe, Candle[]>(), starts = new Map<Timeframe, number[]>()
  for (const timeframe of new Set(requirements.map(item => item.timeframe))) {
    const aggregated = aggregateBidCandles(candles, timeframe)
    bars.set(timeframe, aggregated); starts.set(timeframe, segmentStarts(aggregated))
  }
  const prepared = { candles, days: new Map(calendar.days.map(day => [day.date, day])), bars, segmentStarts: starts }
  const entries = preparedCalendars.get(calendar) ?? new Map<string, PreparedCalendar>()
  entries.set(key, prepared); preparedCalendars.set(calendar, entries)
  return prepared
}
function lowerBound(candles: readonly Candle[], timestamp: number) {
  let low = 0, high = candles.length
  while (low < high) { const middle = (low + high) >>> 1; if (candles[middle].timestamp < timestamp) low = middle + 1; else high = middle }
  return low
}
function completedEnd(bars: readonly Candle[], start: number, timeframe: Timeframe) {
  const width = TIMEFRAME_MS[timeframe]
  let low = 0, high = bars.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (Math.floor(bars[middle].timestamp / width) * width + width <= start) low = middle + 1
    else high = middle
  }
  return low
}
function replayReadiness(candles: readonly Candle[], range: DateRange, requirements: readonly WarmupRequirement[], prepared?: PreparedCalendar): ReplayReadiness | null {
  const from = Date.parse(range.from), to = Date.parse(range.to)
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return null
  const index = lowerBound(candles, from)
  if (index >= candles.length || candles[index].timestamp >= to) return null
  const target = (candles[index] as Partial<TradeCandle>).instrumentId
  const checks = requirements.filter(item => item.periods > 0).map(requirement => {
    const bars = prepared?.bars.get(requirement.timeframe) ?? aggregateBidCandles(candles, requirement.timeframe)
    const starts = prepared?.segmentStarts.get(requirement.timeframe) ?? segmentStarts(bars)
    const end = completedEnd(bars, from, requirement.timeframe), last = bars[end - 1]
    const sameSegment = last && (last as Partial<TradeCandle>).instrumentId === target
    const first = sameSegment ? starts[end - 1] : end
    const count = end - first
    return { ...requirement, count, fromTimestamp: count >= requirement.periods ? bars[end - requirement.periods].timestamp : undefined }
  })
  if (!checks.length || checks.some(check => check.count < check.periods || check.fromTimestamp === undefined)) return null
  const governing = checks.reduce((longest, check) => TIMEFRAME_MS[check.timeframe] * check.periods > TIMEFRAME_MS[longest.timeframe] * longest.periods ? check : longest)
  const earliest = Math.min(...checks.map(check => check.fromTimestamp!))
  return { index, timestamp: candles[index].timestamp, count: governing.count, required: governing.periods, timeframe: governing.timeframe,
    warmupFrom: new Date(earliest).toISOString().slice(0, 10), checks: checks.map(({ fromTimestamp: _fromTimestamp, ...check }) => check) }
}

// Resolve readiness strictly from observations before the requested boundary.
// The first replay observation may follow the boundary after a normal closure,
// but replay time is never spent completing indicator warm-up.
export function automaticReplayStart(candles: readonly Candle[], range: DateRange, requirements: readonly WarmupRequirement[] = DEFAULT_WARMUP_REQUIREMENTS): ReplayReadiness | null {
  return replayReadiness(candles, range, requirements)
}

function unavailable(calendar: CacheCalendar, days: ReadonlyMap<string, CalendarDay>, from: string, to: string): number {
  let missing = 0
  for (let date = from; date && date < to; date = shiftDate(date, 1)) {
    const entry = days.get(date)
    if (!entry || entry.status === 'invalid' || calendar.firstTimestamp !== undefined && Date.parse(date) < Math.floor(calendar.firstTimestamp / 86_400_000) * 86_400_000) missing++
  }
  return missing
}

export function rangeCoverage(calendar: CacheCalendar, range: DateRange, requirements: readonly WarmupRequirement[] = DEFAULT_WARMUP_REQUIREMENTS) {
  const length = (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000
  if (!Number.isFinite(length) || length < 1 || length > MAX_BACKTEST_DAYS) return { missing: 0, replay: null as ReplayReadiness | null, warmupFrom: null as string | null }
  const prepared = prepareCalendar(calendar, requirements)
  const replayMissing = unavailable(calendar, prepared.days, range.from, range.to)
  if (replayMissing) return { missing: replayMissing, replay: null, warmupFrom: null }
  const replay = replayReadiness(prepared.candles, range, requirements, prepared)
  if (!replay) return { missing: 0, replay: null, warmupFrom: null }
  const missing = unavailable(calendar, prepared.days, replay.warmupFrom, range.from)
  return { missing, replay: missing ? null : replay, warmupFrom: replay.warmupFrom }
}

export function cachedPreset(calendar: CacheCalendar, days: number, selectedEnd?: string, requirements: readonly WarmupRequirement[] = DEFAULT_WARMUP_REQUIREMENTS): DateRange | null {
  if (!Number.isInteger(days) || days < 1 || days > MAX_BACKTEST_DAYS) return null
  const ends = calendar.days.filter(day => day.status !== 'invalid').map(day => shiftDate(day.date, 1)).reverse()
  if (selectedEnd) ends.unshift(selectedEnd)
  for (const to of [...new Set(ends)]) {
    const range = { from: shiftDate(to, -days), to }
    const coverage = rangeCoverage(calendar, range, requirements)
    if (!coverage.missing && coverage.replay) return range
  }
  return null
}

export function eligibleRandomRanges(calendar: CacheCalendar, days = 120, requirements: readonly WarmupRequirement[] = DEFAULT_WARMUP_REQUIREMENTS): DateRange[] {
  if (!Number.isInteger(days) || days < 1 || days > MAX_BACKTEST_DAYS) return []
  const ranges: DateRange[] = []
  for (const from of calendar.days.map(day => day.date)) {
    const range = { from, to: shiftDate(from, days) }
    const coverage = rangeCoverage(calendar, range, requirements)
    if (!coverage.missing && coverage.replay) ranges.push(range)
  }
  return ranges
}

export function randomCachedRange(calendar: CacheCalendar, random = Math.random, requirements: readonly WarmupRequirement[] = DEFAULT_WARMUP_REQUIREMENTS): DateRange | null {
  const eligible = eligibleRandomRanges(calendar, 120, requirements)
  if (!eligible.length) return null
  const value = random()
  const index = Math.max(0, Math.min(eligible.length - 1, Math.floor((Number.isFinite(value) ? value : 0) * eligible.length)))
  return eligible[index]
}
