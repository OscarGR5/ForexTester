import { expect, it, vi } from 'vitest'
import type { IPrimitivePaneRenderer, SeriesAttachedParameter, UTCTimestamp } from 'lightweight-charts'
import { CLOUD_COLORS, IchimokuCloudPrimitive } from './ichimokuCloud'

it('draws both crossover colors through the public primitive lifecycle and releases references', () => {
  const primitive = new IchimokuCloudPrimitive()
  const requestUpdate = vi.fn()
  const fillColors: string[] = []
  const context = { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(), fillStyle: '', fill: () => fillColors.push(context.fillStyle) }
  const attached = { chart: { timeScale: () => ({ timeToCoordinate: (time: number) => time }) }, series: { priceToCoordinate: (price: number) => 100 - price }, requestUpdate } as unknown as SeriesAttachedParameter
  const target = { useMediaCoordinateSpace: (draw: (scope: unknown) => void) => draw({ context, mediaSize: { width: 200, height: 100 } }) } as unknown as Parameters<IPrimitivePaneRenderer['draw']>[0]
  primitive.attached(attached)
  primitive.setData([{ time: 0 as UTCTimestamp, a: 90, b: 80 }, { time: 100 as UTCTimestamp, a: 70, b: 80 }])
  expect(requestUpdate).toHaveBeenCalledTimes(1)
  const view = primitive.paneViews()[0]
  expect(view.zOrder?.()).toBe('bottom')
  view.renderer()!.draw(target)
  expect(fillColors).toEqual([CLOUD_COLORS.bullish, CLOUD_COLORS.bearish])
  primitive.detached()
  primitive.setData([])
  view.renderer()!.draw(target)
  expect(fillColors).toHaveLength(2)
  expect(requestUpdate).toHaveBeenCalledTimes(1)
})

it('updates only the cloud tail and requests no redraw for identical projected values', () => {
  const primitive = new IchimokuCloudPrimitive(), requestUpdate = vi.fn()
  primitive.attached({ chart: {}, series: {}, requestUpdate } as unknown as SeriesAttachedParameter)
  const points = Array.from({ length: 1000 }, (_, i) => ({ time: i as UTCTimestamp, a: i % 7, b: i % 11 }))
  primitive.updateTail(points, 0, true)
  expect(requestUpdate).toHaveBeenCalledTimes(1)
  primitive.updateTail(points.slice(990), 990, false)
  expect(requestUpdate).toHaveBeenCalledTimes(1)
  primitive.updateTail([{ ...points[999], a: 99 }], 999, false)
  expect(requestUpdate).toHaveBeenCalledTimes(2)
  primitive.updateTail([], 0, true)
  expect(requestUpdate).toHaveBeenCalledTimes(3)
  primitive.updateTail([], 0, true)
  expect(requestUpdate).toHaveBeenCalledTimes(3)
})

it('limits cloud coordinate conversion to the visible history and its adjacent strips', () => {
  const primitive = new IchimokuCloudPrimitive()
  const convert = vi.fn((time: number) => time - 500)
  const context = { save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {} }
  primitive.attached({ chart: { timeScale: () => ({ getVisibleRange: () => ({ from: 500, to: 510 }), timeToCoordinate: convert }) },
    series: { priceToCoordinate: (price: number) => price }, requestUpdate() {} } as unknown as SeriesAttachedParameter)
  primitive.setData(Array.from({ length: 10000 }, (_, i) => ({ time: i as UTCTimestamp, a: 1, b: 2 })))
  primitive.paneViews()[0].renderer()!.draw({ useMediaCoordinateSpace: (draw: (scope: unknown) => void) => draw({ context, mediaSize: { width: 200, height: 100 } }) } as unknown as Parameters<IPrimitivePaneRenderer['draw']>[0])
  expect(convert.mock.calls.map(([time]) => time)).toEqual(Array.from({ length: 13 }, (_, i) => 499 + i))
})
