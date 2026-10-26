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
  for (const closure of value.days.filter(day => new Date(day.date).getUTCDay() === 0)) {
    closure.status = 'gap'; closure.observations = 0; closure.h4 = []
  }
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


it('needs no preceding observations when indicators are disabled, including zero-period requirements', () => {
  const value = calendar(120, '2024-01-01'), range = { from: value.from!, to: value.to! }
  for (const requirements of [[], [{ timeframe: 'M1', periods: 0 }] as const]) {
    expect(rangeCoverage(value, range, requirements)).toMatchObject({ missing: 0, warmupFrom: range.from,
      replay: { index: 0, timestamp: Date.parse(range.from), count: 0, required: 0, timeframe: null, checks: [] } })
    expect(automaticReplayStart(value.days[0].h4, range, requirements)?.index).toBe(0)
    expect(cachedPreset(value, 120, undefined, requirements)).toEqual(range)
    expect(randomCachedRange(value, () => 0, requirements)).toEqual(range)
  }
  expect(automaticReplayStart([], range, [])).toBeNull()
  expect(automaticReplayStart(value.days[0].h4, { from: value.to!, to: shiftDate(value.to!, 1) }, [])).toBeNull()
})

it('restores 78 completed D1 candles when Ichimoku is enabled and removes the requirement when disabled', () => {
  const value = calendar(200, '2024-01-01'), early = { from: '2024-01-01', to: '2024-01-08' }
  expect(rangeCoverage(value, early, []).replay?.required).toBe(0)
  expect(rangeCoverage(value, early).replay).toBeNull()
  expect(rangeCoverage(value, early, []).replay?.index).toBe(0)
  const boundary = { from: shiftDate(early.from, 78), to: shiftDate(early.from, 79) }
  expect(rangeCoverage(value, boundary).replay).toMatchObject({ required: 78, count: 78, timeframe: 'D1' })
  expect(rangeCoverage(value, { from: shiftDate(early.from, 77), to: boundary.from }).replay).toBeNull()
})

function weekdayCalendar(length = 400): CacheCalendar {
  const value = calendar(length, '2024-01-01')
  for (const day of value.days) if ([0, 6].includes(new Date(day.date).getUTCDay())) {
    day.status = 'gap'; day.observations = 0; day.h4 = []
  }
  return value
}

it('accepts repeated UTC weekend closures for this archive without changing observations', () => {
  const value = weekdayCalendar(), original = JSON.stringify(value)
  expect(rangeCoverage(value, { from: '2024-01-01', to: '2024-04-30' }, []).replay).not.toBeNull()
  expect(JSON.stringify(value)).toBe(original)
})

it('accepts a documented full-day weekday closure but rejects missing or unverified trading days', () => {
  const range = { from: '2024-01-01', to: '2024-04-30' }
  for (const evidence of [undefined, { reason: 'Holiday', source: '' }, { reason: 'Archive fixture closure', source: 'Fixture provider schedule, 2024-02-14' }]) {
    const value = weekdayCalendar(), gap = value.days.find(day => day.date === '2024-02-14')!
    Object.assign(gap, { status: 'gap', observations: 0, h4: [], closure: evidence })
    const coverage = rangeCoverage(value, range, [])
    expect(coverage.replayMissing).toBe(evidence?.source ? 0 : 1)
    expect(Boolean(coverage.replay)).toBe(Boolean(evidence?.source))
    if (!evidence?.source) expect(cachedPreset(value, 120, range.to, [])!.from > '2024-02-14').toBe(true)
  }
})

it('uses this provider’s observed weekend schedule and rejects a missing Sunday when other Sundays trade', () => {
  const value = weekdayCalendar(), sunday = value.days.find(day => day.date === '2024-01-07')!
  Object.assign(sunday, { status: 'cached', observations: 1, h4: [bar(Date.parse(sunday.date) + 22 * 3_600_000)] })
  expect(rangeCoverage(value, { from: '2024-01-13', to: '2024-01-16' }, []).replayMissing).toBe(1)
  expect(rangeCoverage(value, { from: '2024-01-06', to: '2024-01-09' }, []).replayMissing).toBe(0)
})

it('keeps replay data failures distinct from gaps in indicator warm-up', () => {
  for (const missingDate of ['2024-02-14', '2024-04-03']) {
    const value = calendar(300, '2024-01-01')
    Object.assign(value.days.find(day => day.date === missingDate)!, { status: 'gap', observations: 0, h4: [] })
    const coverage = rangeCoverage(value, { from: '2024-04-01', to: '2024-04-08' })
    expect(coverage.replay).toBeNull()
    expect(coverage.replayMissing).toBe(missingDate === '2024-04-03' ? 1 : 0)
    expect(coverage.warmupMissing).toBe(missingDate === '2024-02-14' ? 1 : 0)
  }
})

it('excludes unverified windows, preserves independent intervals, and samples all eligible starts uniformly', () => {
  const value = weekdayCalendar()
  Object.assign(value.days.find(day => day.date === '2024-07-03')!, { status: 'gap', observations: 0, h4: [] })
  const eligible = eligibleRandomRanges(value, 120, [])
  expect(eligible.some(range => range.to <= '2024-07-03')).toBe(true)
  expect(eligible.some(range => range.from > '2024-07-03')).toBe(true)
  expect(eligible.some(range => range.from <= '2024-07-03' && range.to > '2024-07-03')).toBe(false)
  const sample = weekdayCalendar(124), starts = eligibleRandomRanges(sample, 120, [])
  const selected = starts.map((_, index) => randomCachedRange(sample, () => (index + .5) / starts.length, []))
  expect(selected).toEqual(starts)
  expect(new Set(selected.map(range => range!.from)).size).toBe(starts.length)
})
