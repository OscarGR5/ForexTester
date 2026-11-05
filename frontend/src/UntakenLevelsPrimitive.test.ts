import { expect, it, vi } from 'vitest'
import type { IPrimitivePaneRenderer, SeriesAttachedParameter, UTCTimestamp } from 'lightweight-charts'
import { UNTAKEN_COLORS, UntakenLevelsPrimitive } from './UntakenLevelsPrimitive'

it('draws clipped thin solid rays below candles, without axis views or autoscale contributions', () => {
  const primitive = new UntakenLevelsPrimitive(), requestUpdate = vi.fn(), strokes: unknown[] = []
  const context = { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), setLineDash: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), lineWidth: 0, strokeStyle: '', stroke: () => strokes.push([context.strokeStyle, context.lineWidth]) }
  const timeToCoordinate = vi.fn((time: number) => time - 100)
  primitive.attached({ chart: { timeScale: () => ({ getVisibleRange: () => ({ from: 100, to: 200 }), timeToCoordinate }) }, series: { priceToCoordinate: (price: number) => price }, requestUpdate } as unknown as SeriesAttachedParameter)
  primitive.setData([{ time: 1 as UTCTimestamp, price: 10, side: 'high' }, { time: 120 as UTCTimestamp, price: 20, side: 'low' }])
  const view = primitive.paneViews()[0]
  expect(view.zOrder?.()).toBe('bottom')
  const target = { useBitmapCoordinateSpace: (draw: (scope: unknown) => void) => draw({ context, bitmapSize: { width: 200, height: 100 }, horizontalPixelRatio: 1, verticalPixelRatio: 1 }) } as unknown as Parameters<IPrimitivePaneRenderer['draw']>[0]
  view.renderer()!.draw(target)
  expect(strokes).toEqual([[UNTAKEN_COLORS.high, 1], [UNTAKEN_COLORS.low, 1]])
  expect(context.moveTo.mock.calls).toEqual([[0, 10.5], [20, 20.5]])
  expect(context.lineTo.mock.calls).toEqual([[200, 10.5], [200, 20.5]])
  expect(context.setLineDash).toHaveBeenCalledWith([])
  expect(primitive).not.toHaveProperty('priceAxisViews')
  expect(primitive).not.toHaveProperty('autoscaleInfo')
  primitive.detached(); primitive.setData([]); view.renderer()!.draw(target)
  expect(requestUpdate).toHaveBeenCalledTimes(1)
  expect(strokes).toHaveLength(2)
})
