import { expect, it } from 'vitest'
import type { TradeCandle } from './history'
import { automaticReplayStart, cachedPreset, eligibleRandomRanges, formatUtcDate, randomCachedRange, rangeCoverage, type CacheCalendar, type WarmupRequirement } from './cacheCalendar'
import { shiftDate } from './workflow'

const bar = (timestamp: number, instrumentId?: number): TradeCandle => ({ timestamp, instrumentId: instrumentId ?? 101, volume: '1', open: 1, high: 1.2, low: .9, close: 1.1 })
function calendar(length = 520, from = '2023-01-01'): CacheCalendar {
  const days = Array.from({ length }, (_, index) => {
    const date = shiftDate(from, index)
    return { date, status: 'cached' as const, observations: 6, h4: Array.from({ length: 6 }, (_, hour) => bar(Date.parse(date) + hour * 14_400_000)) }
  })
  return { symbol: 'EURUSD', datasetId: 'a'.repeat(64), from, to: shiftDate(from, length), firstTimestamp: Date.parse(from), lastTimestamp: Date.parse(shiftDate(from, length)) - 60_000, days }
}

it.each([7, 30, 90, 180, 365])('selects an exact %i-day replay after separate D1 warm-up', days => {
  const value = calendar()
  const range = cachedPreset(value, days)!
  expect((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000).toBe(days)
  const coverage = rangeCoverage(value, range)
  expect(coverage.missing).toBe(0)
  expect(coverage.replay).toMatchObject({ timestamp: Date.parse(range.from), required: 78, timeframe: 'D1' })
  expect(coverage.warmupFrom).toBe(shiftDate(range.from, -78))
})

it('uses start-inclusive and end-exclusive replay bounds', () => {
  const value = calendar(), range = { from: '2023-11-01', to: '2024-04-29' }
  expect((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000).toBe(180)
  expect(rangeCoverage(value, range).replay?.timestamp).toBe(Date.parse(range.from))
})

it('requires explicit calendar entries but accepts expected closure days without manufacturing bars', () => {
  const value = calendar()
  const closure = value.days.find(day => day.date === '2023-12-24')!
  closure.status = 'gap'; closure.observations = 0; closure.h4 = []
  const range = { from: '2024-01-01', to: '2024-04-01' }
  expect(rangeCoverage(value, range).missing).toBe(0)
  const missingDay = { ...value, days: value.days.filter(day => day.date !== '2023-12-23') }
  expect(rangeCoverage(missingDay, range).missing).toBe(1)
})

it('finds every eligible random start across disjoint cached intervals without crossing the hole', () => {
  const requirements: WarmupRequirement[] = [{ timeframe: 'H4', periods: 2 }]
  const value = calendar(330)
  value.days = value.days.filter(day => day.date < '2023-05-01' || day.date >= '2023-05-11')
  const eligible = eligibleRandomRanges(value, 120, requirements)
  expect(eligible.length).toBeGreaterThan(0)
  expect(eligible.some(range => range.from < '2023-05-01' && range.to > '2023-05-01')).toBe(false)
  expect(eligible.some(range => range.from >= '2023-05-11')).toBe(true)
  expect(randomCachedRange(value, () => 0, requirements)).toEqual(eligible[0])
  expect(randomCachedRange(value, () => .999999, requirements)).toEqual(eligible.at(-1))
})

it('returns no random range when 120 replay days plus warm-up are unavailable', () => {
  expect(randomCachedRange(calendar(119))).toBeNull()
  expect(eligibleRandomRanges({ days: [] })).toEqual([])
})

it('starts at the first observation on or after the requested boundary without consuming replay for warm-up', () => {
  const from = Date.parse('2024-01-10')
  const history = Array.from({ length: 78 }, (_, i) => bar(from - (78 - i) * 86_400_000))
  history.push(bar(from + 36 * 3_600_000))
  const result = automaticReplayStart(history, { from: '2024-01-10', to: '2024-01-12' })!
  expect(result).toMatchObject({ index: 78, timestamp: from + 36 * 3_600_000, count: 78, required: 78, timeframe: 'D1' })
})

it('does not use replay or future observations to satisfy warm-up', () => {
  const from = Date.parse('2024-01-10')
  const before = Array.from({ length: 77 }, (_, i) => bar(from - (77 - i) * 86_400_000))
  const replay = Array.from({ length: 100 }, (_, i) => bar(from + i * 14_400_000))
  expect(automaticReplayStart([...before, ...replay], { from: '2024-01-10', to: '2024-01-20' })).toBeNull()
  before.unshift(bar(from - 78 * 86_400_000))
  const expected = automaticReplayStart([...before, ...replay], { from: '2024-01-10', to: '2024-01-20' })
  const changed = replay.map(item => ({ ...item, high: 10_000, close: 10_000 }))
  expect(automaticReplayStart([...before, ...changed], { from: '2024-01-10', to: '2024-01-20' })).toEqual(expected)
})

it('resets warm-up at a contract boundary and never combines contracts', () => {
  const from = Date.parse('2024-01-10')
  const old = Array.from({ length: 80 }, (_, i) => bar(from - (80 - i) * 14_400_000, 101))
  const current = Array.from({ length: 77 }, (_, i) => bar(from - (77 - i) * 14_400_000, 202))
  const replay = bar(from, 202)
  const requirement = [{ timeframe: 'H4', periods: 78 }] as const
  expect(automaticReplayStart([...old, ...current, replay], { from: '2024-01-10', to: '2024-01-11' }, requirement)).toBeNull()
  current.unshift(bar(from - 78 * 14_400_000, 202))
  expect(automaticReplayStart([...old, ...current, replay], { from: '2024-01-10', to: '2024-01-11' }, requirement)).toMatchObject({ count: 78 })
})

it('formats leap dates in UTC', () => {
  expect(formatUtcDate('2024-02-29')).toBe('29 Feb 2024')
  expect(formatUtcDate(Date.parse('2024-02-29T23:59:00Z'))).toBe('29 Feb 2024')
  expect(formatUtcDate('')).toBe('Choose date')
})

it('rejects empty, reversed and oversized manual ranges without scanning', () => {
  for (const range of [{ from: '', to: '2024-01-01' }, { from: '2020-01-01', to: '2024-01-01' }, { from: '2024-01-02', to: '2024-01-01' }]) {
    expect(rangeCoverage(calendar(), range).replay).toBeNull()
  }
})
