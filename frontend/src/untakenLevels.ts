import type { ChartCandle } from './indicators'

export interface UntakenSettings { enabled: boolean; count: number; pivotStrength: number }
export const DEFAULT_UNTAKEN_SETTINGS: UntakenSettings = { enabled: false, count: 10, pivotStrength: 2 }
export function validUntakenSettings(value: unknown): value is UntakenSettings {
  const settings = value as UntakenSettings
  return !!settings && typeof settings.enabled === 'boolean' && Number.isSafeInteger(settings.count) && settings.count > 0 &&
    Number.isSafeInteger(settings.pivotStrength) && settings.pivotStrength > 0
}
export interface UntakenLevel { time: ChartCandle['time']; price: number; side: 'high' | 'low' }

// Surviving pivot highs decrease in price, lows increase. Rolling extrema
// confirm strict pivots in amortized O(1) per closed candle, independent of S.
// Hidden confirmed levels stay in the stacks without an age limit.
export class UntakenLevels {
  private highs: UntakenLevel[] = []
  private lows: UntakenLevel[] = []
  private processed = 0
  private highWindow: number[] = []
  private lowWindow: number[] = []
  private highHead = 0
  private lowHead = 0
  private pendingHigh: UntakenLevel | null = null
  private pendingLow: UntakenLevel | null = null
  private formingHigh: UntakenLevel | null = null
  private formingLow: UntakenLevel | null = null

  constructor(readonly pivotStrength = 2) {}

  update(candles: readonly ChartCandle[], completed: number, replace = false): void {
    // Recompute the mutable tail rather than letting a candle take its own ray.
    this.formingHigh = null; this.formingLow = null
    if (replace || completed < this.processed) {
      this.highs = []; this.lows = []; this.processed = 0
      this.highWindow = []; this.lowWindow = []; this.highHead = 0; this.lowHead = 0
      this.pendingHigh = null; this.pendingLow = null
    }
    for (; this.processed < completed; this.processed++) {
      const candle = candles[this.processed]
      this.invalidate(candle)
      const left = this.processed - 2 * this.pivotStrength
      while (this.highHead < this.highWindow.length && this.highWindow[this.highHead] < left) this.highHead++
      while (this.lowHead < this.lowWindow.length && this.lowWindow[this.lowHead] < left) this.lowHead++
      // Keep equal extrema in the windows so ties on either side reject a pivot.
      while (this.highWindow.length > this.highHead && candles[this.highWindow.at(-1)!].high < candle.high) this.highWindow.pop()
      while (this.lowWindow.length > this.lowHead && candles[this.lowWindow.at(-1)!].low > candle.low) this.lowWindow.pop()
      // After popping smaller extrema, the tail is the nearest left candle
      // that would disqualify this candidate. At most one pending pivot per
      // side can survive: another within S candles must take its predecessor.
      if (this.processed >= this.pivotStrength) {
        const firstLeft = this.processed - this.pivotStrength
        if (this.highWindow.length === this.highHead || this.highWindow.at(-1)! < firstLeft) {
          this.pendingHigh = { time: candle.time, price: candle.high, side: 'high' }
        }
        if (this.lowWindow.length === this.lowHead || this.lowWindow.at(-1)! < firstLeft) {
          this.pendingLow = { time: candle.time, price: candle.low, side: 'low' }
        }
      }
      this.highWindow.push(this.processed); this.lowWindow.push(this.processed)
      if (left >= 0) {
        const index = this.processed - this.pivotStrength, pivot = candles[index]
        const nextHigh = this.highWindow[this.highHead + 1], nextLow = this.lowWindow[this.lowHead + 1]
        if (this.highWindow[this.highHead] === index && (nextHigh === undefined || candles[nextHigh].high < pivot.high)) {
          this.highs.push({ time: pivot.time, price: pivot.high, side: 'high' })
          if (this.pendingHigh?.time === pivot.time) this.pendingHigh = null
        }
        if (this.lowWindow[this.lowHead] === index && (nextLow === undefined || candles[nextLow].low > pivot.low)) {
          this.lows.push({ time: pivot.time, price: pivot.low, side: 'low' })
          if (this.pendingLow?.time === pivot.time) this.pendingLow = null
        }
      }
      // Compact expired queue entries only; no historical level is discarded.
      if (this.highHead > 1024 && this.highHead * 2 >= this.highWindow.length) { this.highWindow = this.highWindow.slice(this.highHead); this.highHead = 0 }
      if (this.lowHead > 1024 && this.lowHead * 2 >= this.lowWindow.length) { this.lowWindow = this.lowWindow.slice(this.lowHead); this.lowHead = 0 }
    }
    const forming = candles[completed]
    if (forming) {
      this.invalidate(forming)
      if (completed >= this.pivotStrength) {
        const firstLeft = completed - this.pivotStrength
        const high = this.leftExtreme(this.highWindow, this.highHead, firstLeft)
        const low = this.leftExtreme(this.lowWindow, this.lowHead, firstLeft)
        if (high !== undefined && forming.high > candles[high].high) this.formingHigh = { time: forming.time, price: forming.high, side: 'high' }
        if (low !== undefined && forming.low < candles[low].low) this.formingLow = { time: forming.time, price: forming.low, side: 'low' }
      }
    }
  }

  private leftExtreme(window: readonly number[], head: number, first: number): number | undefined {
    let end = window.length
    while (head < end) {
      const middle = (head + end) >>> 1
      if (window[middle] < first) head = middle + 1
      else end = middle
    }
    return window[head]
  }

  private invalidate(candle: ChartCandle): void {
    while (this.highs.length && this.highs.at(-1)!.price <= candle.high) this.highs.pop()
    while (this.lows.length && this.lows.at(-1)!.price >= candle.low) this.lows.pop()
    if (this.pendingHigh && this.pendingHigh.price <= candle.high) this.pendingHigh = null
    if (this.pendingLow && this.pendingLow.price >= candle.low) this.pendingLow = null
  }

  visible(price: number, count: number): UntakenLevel[] {
    const levels: UntakenLevel[] = []
    const latestHigh = this.formingHigh ?? this.pendingHigh, latestLow = this.formingLow ?? this.pendingLow
    // An untaken provisional extreme is newer and nearer than confirmed ones.
    if (latestHigh && latestHigh.price > price) levels.push(latestHigh)
    // The stacks have distinct prices: equal touches pop the earlier level.
    // Walk nearest first, excluding current-price levels without consuming N.
    for (let i = this.highs.length - 1; i >= 0 && levels.length < count; i--) {
      if (this.highs[i].price > price) levels.push(this.highs[i])
    }
    const highCount = levels.length
    if (latestLow && latestLow.price < price) levels.push(latestLow)
    for (let i = this.lows.length - 1; i >= 0 && levels.length - highCount < count; i--) {
      if (this.lows[i].price < price) levels.push(this.lows[i])
    }
    return levels
  }
}
