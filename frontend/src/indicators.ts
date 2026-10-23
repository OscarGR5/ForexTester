import { BollingerBands, Highest, Lowest, SMA, Stochastic } from 'technicalindicators'
import type { CandlestickData, LineData, UTCTimestamp } from 'lightweight-charts'
import { TIMEFRAME_MS, type Timeframe } from './history'

export interface BollingerSettings {
  enabled: boolean; length: number; stdDev: number
  basisVisible: boolean; upperVisible: boolean; lowerVisible: boolean
}
export interface IndicatorSettings {
  bollinger: BollingerSettings
  bollinger2: BollingerSettings
  stochastic: { enabled: boolean; length: number; smoothK: number; smoothD: number }
  ichimoku: { enabled: boolean; tenkan: number; kijun: number; spanB: number; displacement: number }
}
export function defaultIndicatorSettings(): IndicatorSettings {
  return {
    bollinger: { enabled: false, length: 20, stdDev: 2, basisVisible: true, upperVisible: true, lowerVisible: true },
    bollinger2: { enabled: false, length: 20, stdDev: 1, basisVisible: false, upperVisible: true, lowerVisible: true },
    stochastic: { enabled: false, length: 30, smoothK: 10, smoothD: 10 },
    ichimoku: { enabled: false, tenkan: 9, kijun: 26, spanB: 52, displacement: 26 },
  }
}
export function validateIndicatorSettings(settings: IndicatorSettings): string | null {
  for (const [name, group] of Object.entries(settings)) {
    for (const [key, value] of Object.entries(group)) {
      if (['enabled', 'basisVisible', 'upperVisible', 'lowerVisible'].includes(key)) continue
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 ||
        (key === 'stdDev' ? value > 100 : !Number.isInteger(value) || value > 10000)) {
        return `${name}: ${key} must be ${key === 'stdDev' ? 'greater than 0 and at most 100' : 'a whole number from 1 to 10000'}.`
      }
    }
  }
  return null
}
export type IndicatorLine = LineData<UTCTimestamp>[]
export interface CloudPoint { time: UTCTimestamp; a: number; b: number }
export interface IndicatorData {
  upper: IndicatorLine; middle: IndicatorLine; lower: IndicatorLine
  upper2: IndicatorLine; middle2: IndicatorLine; lower2: IndicatorLine
  k: IndicatorLine; d: IndicatorLine
  tenkan: IndicatorLine; kijun: IndicatorLine; spanA: IndicatorLine; spanB: IndicatorLine; chikou: IndicatorLine
  cloud: CloudPoint[]
}
export type ChartCandle = CandlestickData<UTCTimestamp>

// Only the caller's visible, aggregated candles enter this function. No dataset or clock access.
export function calculateIndicators(candles: readonly ChartCandle[], settings: IndicatorSettings, timeframe: Timeframe): IndicatorData {
  const error = validateIndicatorSettings(settings)
  if (error) throw new Error(error)
  const data: IndicatorData = { upper: [], middle: [], lower: [], upper2: [], middle2: [], lower2: [], k: [], d: [], tenkan: [], kijun: [], spanA: [], spanB: [], chikou: [], cloud: [] }
  if (!Object.values(settings).some((group) => group.enabled)) return data
  const bands = [settings.bollinger, settings.bollinger2].map((group) => group.enabled
    ? new BollingerBands({ period: group.length, stdDev: group.stdDev, values: [] }) : null)
  // v3.1.0 declares nextValue as an array input; its runtime consumes one OHLC tick.
  const st = settings.stochastic.enabled ? new Stochastic({ period: settings.stochastic.length, signalPeriod: 1, high: [], low: [], close: [] }) as unknown as { nextValue(tick: Pick<ChartCandle, 'high' | 'low' | 'close'>): { k: number } | undefined } : null
  let smoothK = new SMA({ period: settings.stochastic.smoothK, values: [] })
  let smoothD = new SMA({ period: settings.stochastic.smoothD, values: [] })
  const periods = [settings.ichimoku.tenkan, settings.ichimoku.kijun, settings.ichimoku.spanB]
  const ranges = periods.map((period) => ({ high: new Highest({ period, values: [] }), low: new Lowest({ period, values: [] }) }))
  const displacedTime = (index: number): UTCTimestamp => index < candles.length ? candles[index].time
    : (candles[candles.length - 1].time + (index - candles.length + 1) * TIMEFRAME_MS[timeframe] / 1000) as UTCTimestamp
  candles.forEach((candle, index) => {
    const time = candle.time
    bands.forEach((bb, instance) => {
      const result = bb?.nextValue(candle.close)
      if (!result) return
      const [upper, middle, lower] = instance === 0
        ? [data.upper, data.middle, data.lower] : [data.upper2, data.middle2, data.lower2]
      upper.push({ time, value: result.upper })
      middle.push({ time, value: result.middle })
      lower.push({ time, value: result.lower })
    })
    if (st) {
      const raw = st.nextValue(candle)
      // The package substitutes 0 for an undefined 0/0 raw %K. Omit it and
      // restart smoothing instead of inventing an oscillator observation.
      const window = candles.slice(Math.max(0, index - settings.stochastic.length + 1), index + 1)
      const flat = raw && Math.max(...window.map((bar) => bar.high)) === Math.min(...window.map((bar) => bar.low))
      if (flat) {
        smoothK = new SMA({ period: settings.stochastic.smoothK, values: [] })
        smoothD = new SMA({ period: settings.stochastic.smoothD, values: [] })
      } else if (raw) {
        const k = smoothK.nextValue(raw.k)
        if (k !== undefined) {
          data.k.push({ time, value: k })
          const d = smoothD.nextValue(k)
          if (d !== undefined) data.d.push({ time, value: d })
        }
      }
    }
    if (settings.ichimoku.enabled) {
      // The package's IchimokuCloud waits for the longest period before
      // returning ANY line and doesn't apply displacement. Its Highest/Lowest
      // calculations let each component warm up at its own correct period.
      const [tenkan, kijun, spanB] = ranges.map(({ high, low }) => {
        const h = high.nextValue(candle.high), l = low.nextValue(candle.low)
        return h === undefined || l === undefined ? undefined : (h + l) / 2
      })
      const projected = displacedTime(index + settings.ichimoku.displacement)
      if (tenkan !== undefined) data.tenkan.push({ time, value: tenkan })
      if (kijun !== undefined) data.kijun.push({ time, value: kijun })
      const spanA = tenkan === undefined || kijun === undefined ? undefined : (tenkan + kijun) / 2
      if (spanA !== undefined) data.spanA.push({ time: projected, value: spanA })
      if (spanB !== undefined) data.spanB.push({ time: projected, value: spanB })
      if (spanA !== undefined && spanB !== undefined) data.cloud.push({ time: projected, a: spanA, b: spanB })
      if (index >= settings.ichimoku.displacement) data.chikou.push({ time: candles[index - settings.ichimoku.displacement].time, value: candle.close })
    }
  })
  return data
}
