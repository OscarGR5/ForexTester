import type { ChartCandle } from './indicators'

export interface UntakenSettings { enabled: boolean; count: number }
export const DEFAULT_UNTAKEN_SETTINGS: UntakenSettings = { enabled: false, count: 10 }
export function validUntakenSettings(value: unknown): value is UntakenSettings {
  const settings = value as UntakenSettings
  return !!settings && typeof settings.enabled === 'boolean' && Number.isSafeInteger(settings.count) && settings.count > 0
}
export interface UntakenLevel { time: ChartCandle['time']; price: number; side: 'high' | 'low' }

// Surviving highs decrease in price, lows increase. Each candle is pushed and
// popped at most once. Hidden levels stay in these stacks without an age limit.
export class UntakenLevels {
  private highs: UntakenLevel[] = []
  private lows: UntakenLevel[] = []
  private processed = 0

  update(candles: readonly ChartCandle[], completed: number, replace = false): void {
    if (replace || completed < this.processed) {
      this.highs = []; this.lows = []; this.processed = 0
    }
    for (; this.processed < completed; this.processed++) {
      const candle = candles[this.processed]
      this.invalidate(candle)
      // Invalidate older candles before adding this candle's own levels.
      this.highs.push({ time: candle.time, price: candle.high, side: 'high' })
      this.lows.push({ time: candle.time, price: candle.low, side: 'low' })
    }
    // A forming candle may remove older levels but cannot create its own.
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
