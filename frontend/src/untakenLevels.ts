import type { ChartCandle } from './indicators'

export interface UntakenSettings { enabled: boolean; distanceAtr: number }
export const DEFAULT_UNTAKEN_SETTINGS: UntakenSettings = { enabled: false, distanceAtr: 5 }
export function validUntakenSettings(value: unknown): value is UntakenSettings {
  const settings = value as UntakenSettings
  return !!settings && typeof settings.enabled === 'boolean' && typeof settings.distanceAtr === 'number' &&
    Number.isFinite(settings.distanceAtr) && settings.distanceAtr > 0
}
export interface UntakenLevel { time: ChartCandle['time']; price: number; side: 'high' | 'low' }

// Surviving highs decrease in price, lows increase. Each candle is pushed and
// popped at most once. Hidden levels stay in these stacks without an age limit.
export class UntakenLevels {
  private highs: UntakenLevel[] = []
  private lows: UntakenLevel[] = []
  private processed = 0
  private previousClose: number | undefined
  private trCount = 0
  private trSum = 0
  private atr: number | null = null

  update(candles: readonly ChartCandle[], completed: number, replace = false): void {
    if (replace || completed < this.processed) {
      this.highs = []; this.lows = []; this.processed = 0
      this.previousClose = undefined; this.trCount = 0; this.trSum = 0; this.atr = null
    }
    for (; this.processed < completed; this.processed++) {
      const candle = candles[this.processed]
      this.invalidate(candle)
      // Invalidate older candles before adding this candle's own levels.
      this.highs.push({ time: candle.time, price: candle.high, side: 'high' })
      this.lows.push({ time: candle.time, price: candle.low, side: 'low' })
      if (this.previousClose !== undefined) {
        const tr = Math.max(candle.high - candle.low, Math.abs(candle.high - this.previousClose), Math.abs(candle.low - this.previousClose))
        this.trCount++
        if (this.atr !== null) this.atr = (this.atr * 13 + tr) / 14
        else { this.trSum += tr; if (this.trCount === 14) this.atr = this.trSum / 14 }
      }
      this.previousClose = candle.close
    }
    // A forming candle may remove older levels but cannot create its own.
    if (candles[completed]) this.invalidate(candles[completed])
  }

  private invalidate(candle: ChartCandle): void {
    while (this.highs.length && this.highs.at(-1)!.price <= candle.high) this.highs.pop()
    while (this.lows.length && this.lows.at(-1)!.price >= candle.low) this.lows.pop()
  }

  visible(price: number, multiplier: number): UntakenLevel[] {
    if (this.atr === null) return []
    const distance = this.atr * multiplier, levels: UntakenLevel[] = []
    // Only visit the qualifying suffix of each price-ordered stack.
    for (let i = this.highs.length - 1; i >= 0 && this.highs[i].price - price <= distance; i--) levels.push(this.highs[i])
    for (let i = this.lows.length - 1; i >= 0 && price - this.lows[i].price <= distance; i--) levels.push(this.lows[i])
    return levels
  }
}
