import type { Candle } from './history'
import { performanceCount, performanceEnd, performanceStart } from './replayPerformance'

export interface RegressionChannel {
  startIndex: number
  endIndex: number
  count: number
  intercept: number
  slope: number
  ser: number
  offset: number
}

export const ohlc4 = (candle: Candle): number => (candle.open + candle.high + candle.low + candle.close) / 4

// All timestamps here are UTC milliseconds, as in the authoritative M1 source.
export function firstRegressionObservation(source: readonly Candle[], timestamp: number, count = source.length): number {
  let low = 0, high = Math.min(count, source.length)
  while (low < high) {
    const middle = (low + high) >>> 1
    if (source[middle].timestamp < timestamp) low = middle + 1
    else high = middle
  }
  return low
}

// One calculator per loaded instrument/session, shared by every chart. Forward
// steps visit only new M1 observations. Review/anchor changes rebuild that segment.
export class RegressionCalculator {
  private anchor: number | null = null
  private start = 0
  private processed = 0
  private mean = 0
  private covariance = 0
  private sse = 0
  private origin = 0
  private result: RegressionChannel | null = null
  constructor(private source: readonly Candle[]) {}

  update(anchor: number | null, count: number): RegressionChannel | null {
    count = Math.max(0, Math.min(count, this.source.length))
    if (anchor !== this.anchor || count < this.processed) {
      this.anchor = anchor
      this.start = anchor === null ? 0 : firstRegressionObservation(this.source, anchor)
      this.processed = this.start
      this.mean = this.covariance = this.sse = this.origin = 0
      this.result = null
    }
    if (anchor === null || count <= this.start) return null
    if (this.processed === count) return this.result
    const started = performanceStart(), before = this.processed
    for (; this.processed < count; this.processed++) {
      const n = this.processed - this.start, price = ohlc4(this.source[this.processed])
      if (!n) this.origin = price
      // Subtract a fixed price origin to preserve small FX price differences.
      const y = price - this.origin, dx = (n + 1) / 2, dy = y - this.mean
      if (n >= 2) {
        const sxx = n * (n * n - 1) / 12
        const residual = dy - this.covariance / sxx * dx
        // Recursive least-squares residual update avoids subtracting two large,
        // nearly equal variance sums for a near-perfect linear trend.
        this.sse += residual * residual * (n - 1) * n / ((n + 1) * (n + 2))
      }
      this.mean += dy / (n + 1)
      if (n) this.covariance += dx * (y - this.mean)
    }
    const n = count - this.start
    if (n >= 3) {
      const slope = this.covariance / (n * (n * n - 1) / 12)
      const ser = Math.sqrt(this.sse / (n - 2))
      this.result = { startIndex: this.start, endIndex: count - 1, count: n,
        intercept: this.origin + this.mean - slope * (n - 1) / 2, slope, ser, offset: 2 * ser }
    }
    performanceCount('regression.observations', this.processed - before)
    performanceEnd('regression.calculate', started)
    return this.result
  }
}

export function regressionPrices(channel: RegressionChannel, observation: number) {
  const middle = channel.intercept + channel.slope * observation
  return { middle, upper: middle + channel.offset, lower: middle - channel.offset }
}

export interface RegressionVertex { x: number; observation: number }

// Keep the first/last real M1 vertex in each screen pixel, plus clipping
// neighbors. Binary searches skip hidden history and dense subpixel vertices.
// This bounds drawing by pane width while retaining actual gap endpoints.
export function regressionVertices(channel: RegressionChannel, xAt: (index: number) => number, width: number): RegressionVertex[] {
  if (!Number.isFinite(xAt(channel.startIndex)) || !Number.isFinite(xAt(channel.endIndex))) return []
  const lowerBound = (from: number, x: number) => {
    let low = from, high = channel.endIndex + 1
    while (low < high) {
      const mid = (low + high) >>> 1
      if (xAt(mid) < x) low = mid + 1
      else high = mid
    }
    return low
  }
  const first = Math.max(channel.startIndex, lowerBound(channel.startIndex, 0) - 1)
  const end = Math.min(channel.endIndex, lowerBound(first, width) + 1)
  const points: RegressionVertex[] = []
  const add = (index: number) => points.push({ x: xAt(index), observation: index - channel.startIndex })
  for (let index = first; index <= end;) {
    const x = xAt(index)
    add(index)
    const next = Math.min(end + 1, lowerBound(index + 1, Math.floor(x) + 1))
    if (next > index + 1) add(next - 1)
    index = next
  }
  return points
}
