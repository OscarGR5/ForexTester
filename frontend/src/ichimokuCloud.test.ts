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
