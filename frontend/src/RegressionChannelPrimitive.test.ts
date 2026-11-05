import { expect, it, vi } from 'vitest'
import type { IChartApi, ISeriesApi, SeriesAttachedParameter } from 'lightweight-charts'
import { RegressionChannelPrimitive } from './RegressionChannelPrimitive'
import { RegressionCalculator, regressionPrices, type RegressionChannel } from './regressionChannel'
import { TIMEFRAMES, TIMEFRAME_MS } from './history'

it.each(TIMEFRAMES)('draws the same three channel prices on %s, using M1 fractions and existing time-slot coordinates', timeframe => {
  const times = ['2024-01-12T21:56Z', '2024-01-12T21:58Z', '2024-01-14T22:02Z', '2024-01-14T22:07Z']
  const source = times.map((time, i) => ({ timestamp: Date.parse(time), open: 1 + i * .001, high: 1.003 + i * .002, low: .999, close: 1.001 }))
  const fit = new RegressionCalculator(source).update(source[0].timestamp, source.length)!
  const period = TIMEFRAME_MS[timeframe], bucket = (timestamp: number) => Math.floor(timestamp / period) * period / 1000
  const buckets = [...new Set(source.map(bar => bucket(bar.timestamp)))], spacing = 20
  // Add existing indicator whitespace between the two market sessions.
  const xAtBucket = (time: number) => 30 + buckets.indexOf(time) * spacing + (time >= bucket(source[2].timestamp) ? 40 : 0)
  const timeToCoordinate = vi.fn(xAtBucket), priceToCoordinate = vi.fn((price: number) => 150 - price * 50)
  const chart = { timeScale: () => ({ width: () => 500, options: () => ({ barSpacing: spacing }), timeToCoordinate }) } as unknown as IChartApi
  const series = { priceToCoordinate } as unknown as ISeriesApi<'Candlestick'>
  const requestUpdate = vi.fn(), primitive = new RegressionChannelPrimitive()
  primitive.attached({ chart, series, requestUpdate } as unknown as SeriesAttachedParameter)
  const paths: number[][][] = []
  const context = { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(() => paths.push([])), rect: vi.fn(), clip: vi.fn(), setLineDash: vi.fn(),
    moveTo: vi.fn((x: number, y: number) => paths.at(-1)!.push([x, y])), lineTo: vi.fn((x: number, y: number) => paths.at(-1)!.push([x, y])), stroke: vi.fn() }
  const draw = () => primitive.paneViews()[0].renderer()!.draw({ useMediaCoordinateSpace: (callback: (scope: unknown) => void) => callback({ context, mediaSize: { width: 500, height: 300 } }) } as never)
  primitive.update(fit, source, timeframe); draw()
  expect(primitive.paneViews()[0].zOrder!()).toBe('bottom')
  expect(requestUpdate).toHaveBeenCalledOnce()
  expect(context.stroke).toHaveBeenCalledTimes(3)
  for (const [line, key] of ['upper', 'lower', 'middle'].entries()) {
    const path = paths[line + 1]
    expect(path).toHaveLength(source.length)
    for (let i = 0; i < source.length; i++) {
      const expectedX = xAtBucket(bucket(source[i].timestamp)) + (source[i].timestamp % period) / period * spacing
      expect(path[i][0]).toBeCloseTo(expectedX, 12)
      expect(path[i][1]).toBeCloseTo(priceToCoordinate(regressionPrices(fit, i)[key as 'middle']), 12)
      expect(primitive.containsPoint(path[i][0], path[i][1])).toBe(true)
    }
  }
  context.stroke.mockClear(); primitive.update(null, source, timeframe); draw()
  expect(context.stroke).not.toHaveBeenCalled()
  primitive.detached(); primitive.update(fit, source, timeframe); draw()
  expect(context.stroke).not.toHaveBeenCalled()
})

function hitFixture(slope = 0) {
  const base = Date.UTC(2024, 0, 9)
  const source = [0, 1, 2].map(i => ({ timestamp: base + i * 60000, open: 2, high: 3, low: 1, close: 2 }))
  const fit: RegressionChannel = { startIndex: 0, endIndex: 2, count: 3, intercept: 2, slope, ser: .2, offset: .4 }
  const chart = { timeScale: () => ({ width: () => 300, options: () => ({ barSpacing: 50 }), timeToCoordinate: (time: number) => 50 + (time * 1000 - base) / 60000 * 50 }) } as unknown as IChartApi
  const series = { priceToCoordinate: (price: number) => price * 100 } as unknown as ISeriesApi<'Candlestick'>
  const primitive = new RegressionChannelPrimitive()
  primitive.attached({ chart, series, requestUpdate: vi.fn() } as unknown as SeriesAttachedParameter)
  primitive.update(fit, source, 'M1')
  return { primitive, fit, source }
}
it.each([160, 200, 240])('hits the line at y=%s within 5 screen pixels and rejects points outside the tolerance', y => {
  const { primitive } = hitFixture()
  for (const distance of [0, 4.99, 5]) for (const direction of [-1, 1]) expect(primitive.containsPoint(100, y + direction * distance)).toBe(true)
  for (const direction of [-1, 1]) expect(primitive.containsPoint(100, y + direction * 5.01)).toBe(false)
})
it('measures perpendicular screen distance to sloped segments and bounds their endpoints', () => {
  const { primitive } = hitFixture(.5)
  for (const distance of [4.99, 5.01]) {
    const offset = distance / Math.sqrt(2)
    expect(primitive.containsPoint(100 - offset, 250 + offset)).toBe(distance < 5)
  }
  const horizontal = hitFixture().primitive
  expect(horizontal.containsPoint(45, 200)).toBe(true)
  expect(horizontal.containsPoint(44.99, 200)).toBe(false)
  expect(horizontal.containsPoint(155, 200)).toBe(true)
  expect(horizontal.containsPoint(155.01, 200)).toBe(false)
})
it('cannot hit a cleared or detached channel', () => {
  const { primitive, source, fit } = hitFixture()
  primitive.update(null, source, 'M1')
  expect(primitive.containsPoint(100, 200)).toBe(false)
  primitive.update(fit, source, 'M1'); primitive.detached()
  expect(primitive.containsPoint(100, 200)).toBe(false)
})
