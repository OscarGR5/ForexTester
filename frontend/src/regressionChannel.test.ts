import { expect, it, vi } from 'vitest'
import { TIMEFRAMES, type Candle } from './history'
import { firstRegressionObservation, ohlc4, RegressionCalculator, regressionPrices, regressionVertices } from './regressionChannel'

const source = (prices: number[]): Candle[] => prices.map((price, i) => ({ timestamp: Date.UTC(2024, 0, 9) + i * 60_000, open: price, high: price, low: price, close: price }))
function reference(bars: readonly Candle[]) {
  const prices = bars.map(ohlc4), n = prices.length, xMean = (n - 1) / 2, yMean = prices.reduce((a, b) => a + b, 0) / n
  const slope = prices.reduce((sum, y, x) => sum + (x - xMean) * (y - yMean), 0) / prices.reduce((sum, _, x) => sum + (x - xMean) ** 2, 0)
  const intercept = yMean - slope * xMean
  return { slope, intercept, ser: Math.sqrt(prices.reduce((sum, y, x) => sum + (y - intercept - slope * x) ** 2, 0) / (n - 2)) }
}
it('uses every OHLC component with full precision', () => {
  expect(ohlc4({ timestamp: 0, open: 1.100001, high: 1.200002, low: 1.000003, close: 1.150004 })).toBe((1.100001 + 1.200002 + 1.000003 + 1.150004) / 4)
})
it('fits known OLS coefficients, n − 2 SER and fixed ±2 SER boundaries', () => {
  const bars = source([1, 2, 4, 4, 5]), fit = new RegressionCalculator(bars).update(bars[0].timestamp, bars.length)!
  expect(fit.intercept).toBeCloseTo(1.2, 14)
  expect(fit.slope).toBeCloseTo(1, 14)
  expect(fit.ser).toBeCloseTo(Math.sqrt(.8 / 3), 14)
  expect(fit.offset).toBe(2 * fit.ser)
  for (const i of [0, 2, 4]) {
    const prices = regressionPrices(fit, i)
    expect(prices.middle).toBeCloseTo(1.2 + i, 14)
    expect(prices.upper - prices.middle).toBeCloseTo(2 * fit.ser, 14)
    expect(prices.middle - prices.lower).toBeCloseTo(2 * fit.ser, 14)
  }
})
it.each([1, 1.000000001, 10000])('matches an independent two-pass regression at price scale %s', scale => {
  const bars = source(Array.from({ length: 10_000 }, (_, i) => scale + i * 1e-7 + Math.sin(i * .173) * .0003))
  const expected = reference(bars), calculator = new RegressionCalculator(bars)
  for (const count of [3, 4, 99, 500, bars.length]) {
    const fit = calculator.update(bars[0].timestamp, count)!, current = reference(bars.slice(0, count))
    expect(fit.slope).toBeCloseTo(current.slope, 12)
    expect(fit.intercept).toBeCloseTo(current.intercept, 10)
    expect(fit.ser).toBeCloseTo(current.ser, 12)
  }
  expect(calculator.update(bars[0].timestamp, bars.length)!.ser).toBeCloseTo(expected.ser, 12)
})
it('keeps flat and perfectly linear channels finite without artificial width', () => {
  for (const values of [[1, 1, 1, 1], [1, 2, 3, 4]]) {
    const bars = source(values), fit = new RegressionCalculator(bars).update(bars[0].timestamp, bars.length)!
    expect(fit.ser).toBe(0)
  }
})
it('hides before the anchor and with fewer than three observations, then restores through review and restart', () => {
  const bars = source([1, 2, 4, 4, 5, 6]), calculator = new RegressionCalculator(bars), anchor = bars[2].timestamp
  for (const count of [0, 2, 3, 4]) expect(calculator.update(anchor, count)).toBeNull()
  const fit = calculator.update(anchor, 6)!
  expect(fit.count).toBe(4)
  expect(calculator.update(anchor, 2)).toBeNull()
  expect(calculator.update(anchor, 6)).toEqual(fit)
  expect(calculator.update(null, 6)).toBeNull()
})
it('visits only newly revealed M1 observations, shares cached results across timeframes, and never reads future OHLC', () => {
  const bars = source([1, 2, 4, 4, 5, 6, 7]), reads = bars.map(bar => {
    const price = bar.open, read = vi.fn(() => price)
    Object.defineProperty(bar, 'open', { get: read })
    return read
  })
  const calculator = new RegressionCalculator(bars), anchor = bars[0].timestamp
  const first = calculator.update(anchor, 3)!
  expect(reads.map(read => read.mock.calls.length)).toEqual([1, 1, 1, 0, 0, 0, 0])
  for (const _timeframe of TIMEFRAMES) expect(calculator.update(anchor, 3)).toBe(first)
  calculator.update(anchor, 4)
  expect(reads.map(read => read.mock.calls.length)).toEqual([1, 1, 1, 1, 0, 0, 0])
  calculator.update(anchor, 6)
  expect(reads.map(read => read.mock.calls.length)).toEqual([1, 1, 1, 1, 1, 1, 0])
  const reviewed = calculator.update(anchor, 3)!
  expect(reviewed).toEqual(first)
  expect(reads[6]).not.toHaveBeenCalled()
  expect(calculator.update(bars[1].timestamp, 4)).toMatchObject({ startIndex: 1, endIndex: 3, count: 3 })
})
it('uses consecutive observation indices across missing minutes and weekend gaps', () => {
  const bars = source([1, 2, 4, 4, 5]), times = ['2024-01-12T21:56Z', '2024-01-12T21:58Z', '2024-01-14T22:02Z', '2024-01-14T22:04Z', '2024-01-14T22:07Z']
  bars.forEach((bar, i) => { bar.timestamp = Date.parse(times[i]) })
  const fit = new RegressionCalculator(bars).update(bars[0].timestamp, bars.length)!
  expect(fit).toMatchObject({ slope: 1, count: 5 })
  expect(fit.intercept).toBeCloseTo(1.2, 14)
  expect(firstRegressionObservation(bars, Date.parse('2024-01-12T21:57Z'))).toBe(1)
  expect(firstRegressionObservation(bars, Date.parse('2024-01-13T00:00Z'))).toBe(2)
  expect(firstRegressionObservation(bars, Date.parse('2024-01-15T00:00Z'))).toBe(5)
})
it('changes only the projection across timeframes and preserves gap endpoints without scanning full history', () => {
  const bars = source(Array.from({ length: 500_000 }, (_, i) => 1 + i * 1e-8)), calculator = new RegressionCalculator(bars)
  const fit = calculator.update(bars[0].timestamp, bars.length)!
  for (const _timeframe of TIMEFRAMES) expect(calculator.update(bars[0].timestamp, bars.length)).toBe(fit)
  const xAt = vi.fn((i: number) => i / 500 + (i >= 250000 ? 20 : 0))
  const points = regressionVertices(fit, xAt, 1050)
  expect(points.length).toBeLessThan(2104)
  expect(xAt.mock.calls.length).toBeLessThan(40000)
  expect(points[0].observation).toBe(0)
  expect(points.at(-1)!.observation).toBe(bars.length - 1)
  expect(points.some(p => p.observation === 249999)).toBe(true)
  expect(points.some(p => p.observation === 250000)).toBe(true)
  const clipped = regressionVertices(fit, i => i - 100, 100)
  expect(clipped[0].observation).toBe(99)
  expect(clipped.at(-1)!.observation).toBe(201)
})
