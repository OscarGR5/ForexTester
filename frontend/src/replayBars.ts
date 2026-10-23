import { performanceStart, performanceEnd, performanceCount } from './replayPerformance.js'
import type { CandlestickData, UTCTimestamp } from 'lightweight-charts'
import { TIMEFRAME_MS, type Candle, type Timeframe } from './history'

// Owned by a chart layout effect, never mutated during React render.
export class ReplayBars {
  readonly candles: CandlestickData<UTCTimestamp>[] = []
  private processed = 0
  constructor(private timeframe: Timeframe) {}
  advance(source: readonly Candle[], count: number): number {
    const started = performanceStart()
    const dirty = Math.max(0, this.candles.length - 1)
    const width = TIMEFRAME_MS[this.timeframe]
    for (; this.processed < count; this.processed++) {
      const candle = source[this.processed]
      const time = (Math.floor(candle.timestamp / width) * width / 1000) as UTCTimestamp
      const previous = this.candles.at(-1)
      if (previous?.time === time) this.candles[this.candles.length - 1] = { ...previous,
        high: Math.max(previous.high, candle.high), low: Math.min(previous.low, candle.low), close: candle.close }
      else this.candles.push({ time, open: candle.open, high: candle.high, low: candle.low, close: candle.close })
    }
    performanceEnd('bars.advance', started)
    return dirty
  }
}
