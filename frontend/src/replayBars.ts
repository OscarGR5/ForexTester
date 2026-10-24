import { performanceStart, performanceEnd } from './replayPerformance.js'
import type { CandlestickData, UTCTimestamp } from 'lightweight-charts'
import { TIMEFRAME_MS, type Candle, type Timeframe } from './history'

// Owned by a chart layout effect, never mutated during React render.
export class ReplayBars {
  readonly candles: CandlestickData<UTCTimestamp>[] = []
  private processed = 0
  private instrumentId: unknown
  private bucket: number | null = null
  constructor(private timeframe: Timeframe) {}
  advance(source: readonly Candle[], count: number): number {
    const started = performanceStart()
    let dirty = this.candles.length
    const width = TIMEFRAME_MS[this.timeframe]
    for (; this.processed < count; this.processed++) {
      const candle = source[this.processed]
      const bucket = Math.floor(candle.timestamp / width) * width / 1000
      const instrumentId = (candle as Candle & { instrumentId?: number }).instrumentId
      const switched = this.processed > 0 && instrumentId !== this.instrumentId
      const time = (switched && this.bucket === bucket ? candle.timestamp / 1000 : bucket) as UTCTimestamp
      const previous = this.candles.at(-1)
      if (previous && this.bucket === bucket && !switched) {
        const high = Math.max(previous.high, candle.high), low = Math.min(previous.low, candle.low)
        if (high !== previous.high || low !== previous.low || candle.close !== previous.close) {
          dirty = Math.min(dirty, this.candles.length - 1)
          this.candles[this.candles.length - 1] = { ...previous, high, low, close: candle.close }
        }
      } else {
        dirty = Math.min(dirty, this.candles.length)
        this.candles.push({ time, open: candle.open, high: candle.high, low: candle.low, close: candle.close })
      }
      this.bucket = bucket; this.instrumentId = instrumentId
    }
    performanceEnd('bars.advance', started)
    return dirty
  }
}
