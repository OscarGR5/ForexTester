import { expect, it, vi } from 'vitest'
import type { IChartApi } from 'lightweight-charts'
import { ChartTimeSlots } from './chartTimeSlots'
import type { ChartCandle } from './indicators'
it('batches only new revealed time slots, skips single appends and clears on history replacement', () => {
  const setData = vi.fn(), addSeries = vi.fn(() => ({ setData }))
  const slots = new ChartTimeSlots({ addSeries } as unknown as IChartApi)
  const candles = Array.from({ length: 12 }, (_, i) => ({ time: (i * 60) as ChartCandle['time'], open: 1, high: 2, low: .5, close: 1.5 }))
  slots.prepare(candles.slice(0, 5), true)
  expect(setData).toHaveBeenLastCalledWith([])
  slots.prepare(candles.slice(0, 6), false)
  expect(setData).toHaveBeenCalledTimes(1)
  slots.prepare(candles.slice(0, 10), false)
  expect(setData).toHaveBeenLastCalledWith(candles.slice(6, 10).map(({ time }) => ({ time })))
  slots.prepare(candles.slice(0, 10), false)
  expect(setData).toHaveBeenCalledTimes(2)
  slots.prepare(candles.slice(0, 2), true)
  expect(setData).toHaveBeenLastCalledWith([])
  expect(addSeries).toHaveBeenCalledTimes(1)
})
