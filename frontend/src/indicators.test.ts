import { describe, expect, it } from 'vitest'
import { calculateIndicators, defaultIndicatorSettings, validateIndicatorSettings, type ChartCandle } from './indicators'
import { TIMEFRAMES, TIMEFRAME_MS, toBidChartCandles, type Candle } from './history'
import { cloudPolygons } from './ichimokuCloud'

const bars = (closes: number[]): ChartCandle[] => closes.map((close, index) => ({ time: (1704758400 + index * 60) as ChartCandle['time'], open: close, high: close + 2, low: close - 2, close }))
function settings() {
  const s = defaultIndicatorSettings()
  s.bollinger = { ...s.bollinger, enabled: true, length: 3, stdDev: 2 }
  s.bollinger2 = { ...s.bollinger2, enabled: true, length: 3 }
  s.stochastic = { enabled: true, length: 3, smoothK: 2, smoothD: 2 }
  s.ichimoku = { enabled: true, tenkan: 2, kijun: 3, spanB: 4, displacement: 2 }
  return s
}

describe('indicator calculations', () => {
  it('uses close SMA and population standard deviation for Bollinger Bands', () => {
    const data = calculateIndicators(bars([10, 12, 14, 18]), settings(), 'M1')
    expect(data.middle.map((p) => p.value)).toEqual([12, 44 / 3])
    expect(data.upper[0].value).toBeCloseTo(12 + 2 * Math.sqrt(8 / 3), 12)
    expect(data.lower[0].value).toBeCloseTo(12 - 2 * Math.sqrt(8 / 3), 12)
    expect(data.middle[0].time).toBe(bars([10, 12, 14])[2].time)
  })
  it('uses the approved defaults and independent settings objects', () => {
    const defaults = defaultIndicatorSettings()
    expect(defaults.bollinger).toEqual({ enabled: false, length: 20, stdDev: 2, basisVisible: true, upperVisible: true, lowerVisible: true })
    expect(defaults.bollinger2).toEqual({ enabled: false, length: 20, stdDev: 1, basisVisible: false, upperVisible: true, lowerVisible: true })
    expect(defaults.stochastic).toEqual({ enabled: false, length: 30, smoothK: 10, smoothD: 10 })
    expect(defaults.ichimoku).toEqual({ enabled: false, tenkan: 9, kijun: 26, spanB: 52, displacement: 26 })
    defaults.bollinger.length = 7
    expect(defaults.bollinger2.length).toBe(20)
    expect(defaultIndicatorSettings().bollinger.length).toBe(20)
  })
  it('calculates both bands independently on the same candles', () => {
    const s = settings(), source = bars([10, 12, 14, 18])
    const result = calculateIndicators(source, s, 'M1')
    expect(result.middle2).toEqual(result.middle)
    expect(result.upper2[0].value).toBeCloseTo(12 + Math.sqrt(8 / 3), 12)
    expect(result.lower2[0].value).toBeCloseTo(12 - Math.sqrt(8 / 3), 12)
    s.bollinger2.length = 4
    const changed = calculateIndicators(source, s, 'M1')
    expect(changed.upper).toEqual(result.upper)
    expect(changed.upper2).toHaveLength(1)
    s.bollinger.enabled = false
    const single = calculateIndicators(source, s, 'M1')
    expect(single.upper).toEqual([])
    expect(single.upper2).toEqual(changed.upper2)
  })
  it('warms up default stochastic at candles 39 and 48', () => {
    const s = defaultIndicatorSettings()
    s.stochastic.enabled = true
    const source = bars(Array.from({ length: 50 }, (_, i) => 10 + i))
    const data = calculateIndicators(source, s, 'M1')
    expect(data.k[0].time).toBe(source[38].time)
    expect(data.d[0].time).toBe(source[47].time)
  })
  it('smooths raw %K to slow %K and then %D with independent warm-ups', () => {
    // Each rising 3-bar window spans 6. Raw K=100*(close-(close-4))/6=200/3.
    const data = calculateIndicators(bars([10, 11, 12, 13, 14, 15]), settings(), 'M1')
    expect(data.k).toHaveLength(3)
    expect(data.d).toHaveLength(2)
    expect(data.k[0].time).toBe(1704758400 + 3 * 60)
    expect(data.d[0].time).toBe(1704758400 + 4 * 60)
    for (const point of [...data.k, ...data.d]) expect(point.value).toBeCloseTo(200 / 3, 12)
    const changing = bars([10, 12, 11, 15, 13, 16])
    // Raw K: 3/6, 6/8, 4/8, 5/7, each *100.
    const result = calculateIndicators(changing, settings(), 'M1')
    expect(result.k[0].value).toBeCloseTo(62.5)
    expect(result.k[1].value).toBeCloseTo(62.5)
    expect(result.k[2].value).toBeCloseTo((50 + 500 / 7) / 2)
    expect(result.d[0].value).toBeCloseTo(62.5)
    expect(result.d[1].value).toBeCloseTo((62.5 + (50 + 500 / 7) / 2) / 2)
  })
  it('omits undefined flat-range stochastic and restarts smoothing', () => {
    const data = calculateIndicators(bars([10, 10, 10, 10]).map((bar) => ({ ...bar, high: 10, low: 10 })), settings(), 'M1')
    expect(data.k).toEqual([]); expect(data.d).toEqual([])
  })
  it('calculates all five Ichimoku components and shifts by candle positions', () => {
    const source = bars([10, 12, 14, 18, 20])
    const data = calculateIndicators(source, settings(), 'M1')
    expect(data.tenkan.map((p) => p.value)).toEqual([11, 13, 16, 19])
    expect(data.kijun.map((p) => p.value)).toEqual([12, 15, 17])
    expect(data.spanA.map((p) => p.value)).toEqual([12.5, 15.5, 18])
    expect(data.spanB.map((p) => p.value)).toEqual([14, 16])
    expect(data.spanA[0].time).toBe(source[4].time)
    expect(data.spanA.at(-1)!.time).toBe(source[4].time + 120)
    expect(data.chikou).toEqual(source.slice(2).map((bar, index) => ({ time: source[index].time, value: bar.close })))
    expect(data.cloud.map((p) => [p.a, p.b])).toEqual([[15.5, 14], [18, 16]])
  })
  it('uses existing candle positions across gaps, and only nominal intervals beyond the visible edge', () => {
    const source = bars([10, 11, 12, 13, 14])
    source[4].time = (source[4].time + 172800) as ChartCandle['time']
    const data = calculateIndicators(source, settings(), 'M1')
    expect(data.spanA[0].time).toBe(source[4].time)
    expect(data.spanA[1].time).toBe(source[4].time + 60)
    expect(data.chikou[2].time).toBe(source[2].time)
  })
  it('has no fabricated warm-up values and keeps indicators disabled initially', () => {
    const defaults = defaultIndicatorSettings()
    expect(Object.values(calculateIndicators(bars([10, 11, 12]), defaults, 'M1')).every((line) => line.length === 0)).toBe(true)
    const s = settings(), data = calculateIndicators(bars([10]), s, 'M1')
    expect(Object.values(data).every((line) => line.length === 0)).toBe(true)
    s.ichimoku.displacement = 100
    expect(calculateIndicators(bars([10, 11, 12, 13]), s, 'M1').tenkan).toHaveLength(3)
  })
  it('matches uninterrupted D1 Ichimoku at replay start with exactly 78 completed warm-up candles', () => {
    const s = defaultIndicatorSettings(); s.ichimoku.enabled = true
    const source = Array.from({ length: 121 }, (_, index): ChartCandle => {
      const price = 100 + index / 10
      return { time: (Date.UTC(2023, 0, 1) / 1000 + index * 86_400) as ChartCandle['time'],
        open: price, high: price + 2 + Math.sin(index), low: price - 2 - Math.cos(index), close: price }
    })
    const replayIndex = 100, replayTime = source[replayIndex].time
    const uninterrupted = calculateIndicators(source.slice(0, replayIndex + 1), s, 'D1')
    const warmed = calculateIndicators(source.slice(replayIndex - 78, replayIndex + 1), s, 'D1')
    expect(warmed.cloud.find(point => point.time === replayTime)).toEqual(uninterrupted.cloud.find(point => point.time === replayTime))
    expect(warmed.tenkan.at(-1)).toEqual(uninterrupted.tenkan.at(-1))
    expect(warmed.kijun.at(-1)).toEqual(uninterrupted.kijun.at(-1))
  })
  it('validates every numeric parameter, including disabled indicators', () => {
    expect(validateIndicatorSettings(defaultIndicatorSettings())).toBeNull()
    for (const [group, values] of Object.entries(settings())) for (const key of Object.keys(values).filter((k) => !['enabled', 'basisVisible', 'upperVisible', 'lowerVisible'].includes(k))) {
      for (const value of [0, -1, NaN, Infinity, 10001, ...(key === 'stdDev' ? [101] : [1.5])]) {
        const s = settings()
        Object.assign(s[group as keyof typeof s], { [key]: value })
        expect(validateIndicatorSettings(s)).not.toBeNull()
      }
    }
    const s = settings(); s.bollinger.stdDev = 0.5
    expect(validateIndicatorSettings(s)).toBeNull()
  })
  for (const timeframe of TIMEFRAMES) it(`updates incomplete ${timeframe} buckets from the visible prefix without extreme future OHLC`, () => {
    const step = TIMEFRAME_MS[timeframe]
    const source: Candle[] = Array.from({ length: 6 }, (_, index) => ({ timestamp: 1704758400000 + index * step, open: 10 + index, high: 12 + index, low: 8 + index, close: 10 + index }))
    source.push({ timestamp: source.at(-1)!.timestamp + 60000, open: 15, high: 25, low: 5, close: 24 })
    const future = { timestamp: source.at(-1)!.timestamp + step, open: 24, high: 1e6, low: 0.001, close: 99999 }
    const full = [...source, future]
    for (let count = 1; count <= source.length; count++) {
      const visible = toBidChartCandles({ bid: full.slice(0, count) }, timeframe)
      const independent = toBidChartCandles({ bid: source.slice(0, count) }, timeframe)
      expect(calculateIndicators(visible, settings(), timeframe)).toEqual(calculateIndicators(independent, settings(), timeframe))
    }
    const before = calculateIndicators(toBidChartCandles({ bid: source.slice(0, -1) }, timeframe), settings(), timeframe)
    const after = calculateIndicators(toBidChartCandles({ bid: source }, timeframe), settings(), timeframe)
    expect(after.middle.at(-1)!.value).not.toBe(before.middle.at(-1)!.value)
    if (timeframe !== 'M1') expect(after.middle.at(-1)!.time).toBe(before.middle.at(-1)!.time)
    expect(after.tenkan.at(-1)!.value).toBeLessThan(25)
    expect(after.spanB.at(-1)!.time).toBe(toBidChartCandles({ bid: source }, timeframe).at(-1)!.time + 2 * step / 1000)
  })
})

describe('cloud geometry', () => {
  it('splits bullish and bearish fills exactly at a crossover', () => {
    const polygons = cloudPolygons({ x: 0, a: 10, b: 20 }, { x: 100, a: 30, b: 20 })
    expect(polygons.map((p) => p.bullish)).toEqual([true, false])
    expect(polygons[0].vertices[1]).toEqual({ x: 50, y: 20 })
    expect(polygons[1].vertices[0]).toEqual({ x: 50, y: 20 })
  })
  it('handles equal endpoints and flat spans without dividing by zero', () => {
    for (const [a, b] of [[10, 20], [30, 20], [20, 20]]) {
      const polygons = cloudPolygons({ x: 0, a, b }, { x: 10, a, b })
      expect(polygons).toHaveLength(1)
      expect(polygons[0].vertices.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true)
    }
  })
})
