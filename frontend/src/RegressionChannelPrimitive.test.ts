import { expect, it, vi } from 'vitest'
import type { IChartApi, ISeriesApi, SeriesAttachedParameter } from 'lightweight-charts'
import { RegressionChannelPrimitive } from './RegressionChannelPrimitive'
import { RegressionCalculator, regressionPrices } from './regressionChannel'
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
  const chart = { timeScale: () => ({ options: () => ({ barSpacing: spacing }), timeToCoordinate }) } as unknown as IChartApi
  const series = { priceToCoordinate } as unknown as ISeriesApi<'Candlestick'>
  const requestUpdate = vi.fn(), primitive = new RegressionChannelPrimitive()
  primitive.attached({ chart, series, requestUpdate } as unknown as SeriesAttachedParameter)
  const paths: number[][][] = []
  const context = { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(() => paths.push([])), rect: vi.fn(), clip: vi.fn(), setLineDash: vi.fn(),
    moveTo: vi.fn((x: number, y: number) => paths.at(-1)!.push([x, y])), lineTo: vi.fn((x: number, y: number) => paths.at(-1)!.push([x, y])), stroke: vi.fn() }
  const draw = () => primitive.paneViews()[0].renderer()!.draw({ useMediaCoordinateSpace: (callback: (scope: unknown) => void) => callback({ context, mediaSize: { width: 500, height: 300 } }) } as never)
  primitive.update(fit, source, timeframe); draw()
  expect(requestUpdate).toHaveBeenCalledOnce()
  expect(context.stroke).toHaveBeenCalledTimes(3)
  for (const [line, key] of ['upper', 'lower', 'middle'].entries()) {
    const path = paths[line + 1]
    expect(path).toHaveLength(source.length)
    for (let i = 0; i < source.length; i++) {
      const expectedX = xAtBucket(bucket(source[i].timestamp)) + (source[i].timestamp % period) / period * spacing
      expect(path[i][0]).toBeCloseTo(expectedX, 12)
      expect(path[i][1]).toBeCloseTo(priceToCoordinate(regressionPrices(fit, i)[key as 'middle']), 12)
    }
  }
  context.stroke.mockClear(); primitive.update(null, source, timeframe); draw()
  expect(context.stroke).not.toHaveBeenCalled()
  primitive.detached(); primitive.update(fit, source, timeframe); draw()
  expect(context.stroke).not.toHaveBeenCalled()
})
