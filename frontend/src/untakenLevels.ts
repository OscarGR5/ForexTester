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

  constructor(readonly pivotStrength = 2) {}

  update(candles: readonly ChartCandle[], completed: number, replace = false): void {
    if (replace || completed < this.processed) {
      this.highs = []; this.lows = []; this.processed = 0
      this.highWindow = []; this.lowWindow = []; this.highHead = 0; this.lowHead = 0
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
      this.highWindow.push(this.processed); this.lowWindow.push(this.processed)
      if (left >= 0) {
        const index = this.processed - this.pivotStrength, pivot = candles[index]
        const nextHigh = this.highWindow[this.highHead + 1], nextLow = this.lowWindow[this.lowHead + 1]
        if (this.highWindow[this.highHead] === index && (nextHigh === undefined || candles[nextHigh].high < pivot.high)) {
          this.highs.push({ time: pivot.time, price: pivot.high, side: 'high' })
        }
        if (this.lowWindow[this.lowHead] === index && (nextLow === undefined || candles[nextLow].low > pivot.low)) {
          this.lows.push({ time: pivot.time, price: pivot.low, side: 'low' })
        }
      }
      // Compact expired queue entries only; no historical level is discarded.
      if (this.highHead > 1024 && this.highHead * 2 >= this.highWindow.length) { this.highWindow = this.highWindow.slice(this.highHead); this.highHead = 0 }
      if (this.lowHead > 1024 && this.lowHead * 2 >= this.lowWindow.length) { this.lowWindow = this.lowWindow.slice(this.lowHead); this.lowHead = 0 }
    }
    // A forming candle may take confirmed levels but cannot confirm a pivot.
    if (candles[completed]) this.invalidate(candles[completed])
  }

  private invalidate(candle: ChartCandle): void {
    while (this.highs.length && this.highs.at(-1)!.price <= candle.high) this.highs.pop()
    while (this.lows.length && this.lows.at(-1)!.price >= candle.low) this.lows.pop()
  }

  visible(price: number, count: number): UntakenLevel[] {
    const levels: UntakenLevel[] = []
    // The stacks have distinct prices: equal touches pop the earlier level.
    // Walk nearest first, excluding current-price levels without consuming N.
    for (let i = this.highs.length - 1; i >= 0 && levels.length < count; i--) {
      if (this.highs[i].price > price) levels.push(this.highs[i])
    }
    const highCount = levels.length
    for (let i = this.lows.length - 1; i >= 0 && levels.length - highCount < count; i--) {
      if (this.lows[i].price < price) levels.push(this.lows[i])
    }
    return levels
  }
}
