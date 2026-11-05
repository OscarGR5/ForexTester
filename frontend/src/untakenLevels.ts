import type { ChartCandle } from './indicators'

export interface UntakenSettings { enabled: boolean; count: number }
export const DEFAULT_UNTAKEN_SETTINGS: UntakenSettings = { enabled: false, count: 10 }
export function validUntakenSettings(value: unknown): value is UntakenSettings {
  const settings = value as UntakenSettings
  return !!settings && typeof settings.enabled === 'boolean' && Number.isSafeInteger(settings.count) && settings.count > 0 &&
    Object.keys(settings).every(key => key === 'enabled' || key === 'count')
}
export interface UntakenLevel { time: ChartCandle['time']; price: number; side: 'high' | 'low' }

// Strictly weaker closed candles bound a local extreme or equal-price plateau.
// Surviving highs decrease in price, lows increase; hidden levels have no age
// limit. Each level is pushed and popped at most once during forward replay.
export class UntakenLevels {
  private highs: UntakenLevel[] = []
  private lows: UntakenLevel[] = []
  private processed = 0
  private pendingHigh: UntakenLevel | null = null
  private pendingLow: UntakenLevel | null = null
  private formingHigh: UntakenLevel | null = null
  private formingLow: UntakenLevel | null = null

  update(candles: readonly ChartCandle[], completed: number, replace = false): void {
    // Recompute the mutable tail rather than letting a candle take its own ray.
    this.formingHigh = null; this.formingLow = null
    if (replace || completed < this.processed) {
      this.highs = []; this.lows = []; this.processed = 0
      this.pendingHigh = null; this.pendingLow = null
    }
    for (; this.processed < completed; this.processed++) {
      const candle = candles[this.processed]
      this.invalidate(candle)
      if (this.pendingHigh && candle.high < this.pendingHigh.price) {
        this.highs.push(this.pendingHigh); this.pendingHigh = null
      }
      if (this.pendingLow && candle.low > this.pendingLow.price) {
        this.lows.push(this.pendingLow); this.pendingLow = null
      }
      const previous = candles[this.processed - 1]
      // Exact equals extend the pending sequence and retain its first anchor.
      // A stricter extreme starts a new sequence after taking the old one.
      if (previous && candle.high > previous.high) this.pendingHigh = { time: candle.time, price: candle.high, side: 'high' }
      if (previous && candle.low < previous.low) this.pendingLow = { time: candle.time, price: candle.low, side: 'low' }
    }
    const forming = candles[completed]
    if (forming) {
      this.invalidate(forming)
      const previous = candles[completed - 1]
      if (previous && forming.high > previous.high) this.formingHigh = { time: forming.time, price: forming.high, side: 'high' }
      if (previous && forming.low < previous.low) this.formingLow = { time: forming.time, price: forming.low, side: 'low' }
    }
  }

  private invalidate(candle: ChartCandle): void {
    while (this.highs.length && this.highs.at(-1)!.price <= candle.high) this.highs.pop()
    while (this.lows.length && this.lows.at(-1)!.price >= candle.low) this.lows.pop()
    // Equal prices are still inside the originating, unconfirmed plateau.
    if (this.pendingHigh && this.pendingHigh.price < candle.high) this.pendingHigh = null
    if (this.pendingLow && this.pendingLow.price > candle.low) this.pendingLow = null
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
