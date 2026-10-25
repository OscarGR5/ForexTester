import type { EquityLedger, EquityPoint } from './equity'

export interface ExecutedInterval { entryTime: number; exitTime?: number }

export function equityWindowStart(points: readonly EquityPoint[], positions: readonly ExecutedInterval[]): number {
  const first = points[0]?.timestamp ?? 0
  if (!positions.length) return first
  let firstEntry = Infinity
  for (const position of positions) firstEntry = Math.min(firstEntry, position.entryTime)
  return Math.max(first, Math.floor(firstEntry / 86_400_000) * 86_400_000 - 86_400_000)
}

// UTC day before the first actual fill. Keep real observations, never synthesize
// a midnight value, and leave the complete ledger available to every KPI/save.
export function equityWindow(points: readonly EquityPoint[], positions: readonly ExecutedInterval[]): readonly EquityPoint[] {
  if (!positions.length) return points
  const start = equityWindowStart(points, positions)
  let low = 0, high = points.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (points[mid].timestamp < start) low = mid + 1
    else high = mid
  }
  return points.slice(low)
}

// Right endpoints of confirmed constant gaps, established from FULL-resolution
// neighbors and executed exposure. Sorting once avoids scanning every position
// for every M1 point. An exit at the left observation is already in its cash.
export function flatEquityGaps(points: readonly EquityPoint[], positions: readonly ExecutedInterval[]): ReadonlySet<number> {
  const intervals = [...positions].sort((a, b) => a.entryTime - b.entryTime)
  const connected = new Set<number>()
  let cursor = 0, latestExit = -Infinity
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1], point = points[index]
    if (!point.clockGap) continue
    while (cursor < intervals.length && intervals[cursor].entryTime <= point.timestamp) {
      latestExit = Math.max(latestExit, intervals[cursor++].exitTime ?? Infinity)
    }
    if (latestExit > previous.timestamp) continue
    if ([previous, point].every(p => p.equityUsd !== null && Number.isFinite(p.equityUsd) && Number.isFinite(p.cashUsd)
      && p.unrealizedUsd === 0 && p.missingSides.length === 0)
      && previous.cashUsd === point.cashUsd && previous.equityUsd === point.equityUsd) connected.add(point.timestamp)
  }
  return connected
}

export function equityObservations(ledger: EquityLedger): EquityPoint[] {
  const points: EquityPoint[] = new Array(ledger.count)
  let node = ledger.tail
  for (let index = points.length - 1; node; node = node.previous) points[index--] = node.point
  return points
}

// Display only. Keep time-bucket endpoints and all financial extrema, plus both
// sides of missing observations and clock gaps. The ledger remains untouched.
export function downsampleEquity(points: readonly EquityPoint[], pixels: number): EquityPoint[] {
  if (points.length <= pixels * 4) return [...points]
  const first = points[0].timestamp, span = points.at(-1)!.timestamp - first || 1
  const selected = new Set<number>([0, points.length - 1])
  let bucket = -1, start = 0, min = 0, max = 0, dd = 0, cashMin = 0, cashMax = 0
  const flush = (end: number) => { for (const index of [start, end, min, max, dd, cashMin, cashMax]) selected.add(index) }
  for (let index = 0; index < points.length; index++) {
    const point = points[index]
    const nextBucket = Math.floor((point.timestamp - first) / span * Math.max(1, pixels / 4))
    if (nextBucket !== bucket) {
      if (index) flush(index - 1)
      bucket = nextBucket; start = min = max = dd = cashMin = cashMax = index
    }
    if (point.equityUsd !== null) {
      if (points[min].equityUsd === null || point.equityUsd < points[min].equityUsd!) min = index
      if (points[max].equityUsd === null || point.equityUsd > points[max].equityUsd!) max = index
      if ((point.drawdownUsd ?? 0) > (points[dd].drawdownUsd ?? 0)) dd = index
    }
    if (point.cashUsd < points[cashMin].cashUsd) cashMin = index
    if (point.cashUsd > points[cashMax].cashUsd) cashMax = index
    // Preserve validity transitions for each displayed series, including invalid
    // numeric marks and unavailable peak percentages at nonpositive equity.
    const valid = (value: number | null) => value !== null && Number.isFinite(value)
    if (point.clockGap || (index && (
      valid(point.equityUsd) !== valid(points[index - 1].equityUsd)
      || valid(point.drawdownPercent) !== valid(points[index - 1].drawdownPercent)))) {
      selected.add(index); if (index) selected.add(index - 1)
    }
  }
  flush(points.length - 1)
  return [...selected].sort((a, b) => a - b).map((index) => points[index])
}

// Cache completed 128-observation display blocks. Their endpoints, extrema and
// both sides of gaps survive further display downsampling. Financial data stays
// in the immutable ledger, with every M1 point available to persistence.
export class EquityDisplay {
  private tail: EquityLedger['tail'] = null
  private points: EquityPoint[] = []
  private blocks: EquityPoint[][] = []
  private readonly blockSize = 128

  update(ledger: EquityLedger, pixels: number): EquityPoint[] {
    const added: EquityPoint[] = []
    let node = ledger.tail
    const difference = ledger.count - this.points.length
    if (difference >= 0) for (let i = 0; i < difference && node; i++, node = node.previous) added.push(node.point)
    if (difference < 0 || node !== this.tail) {
      this.points = equityObservations(ledger)
      this.blocks = []
    } else {
      for (let i = added.length - 1; i >= 0; i--) this.points.push(added[i])
    }
    this.tail = ledger.tail
    const size = this.blockSize
    // Include an adjoining observation in each block so gaps crossing a block
    // boundary retain the immediately preceding observation too.
    for (let i = this.blocks.length; (i + 1) * size < this.points.length; i++) {
      this.blocks.push(downsampleEquity(this.points.slice(Math.max(0, i * size - 1), (i + 1) * size + 1), 1))
    }
    if (this.points.length <= pixels * 4) return [...this.points]
    const candidates = this.blocks.flat()
    candidates.push(...this.points.slice(Math.max(0, this.blocks.length * size - 1)))
    // Neighboring blocks share endpoints. Keep one chronological copy.
    const unique: EquityPoint[] = []
    for (const point of candidates) if (!unique.length || point.timestamp > unique.at(-1)!.timestamp) unique.push(point)
    return downsampleEquity(unique, pixels)
  }
}
