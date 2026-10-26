import { expect, it, vi } from 'vitest'
import { HistoryLoader, ichimokuWarmup, replayStartIndex } from './historyLoader'
import { validateDateRange } from './history'
import { fixtureHistory } from '../../tests/databentoFixture'
it.each([1, 7, 30, 90, 180, 365])('accepts %i selected calendar days', days => {
  expect(validateDateRange({ from: '2024-01-01', to: new Date(Date.UTC(2024, 0, 1 + days)).toISOString().slice(0, 10) }, '2025-01-01')).toBeNull()
})
it('rejects 366 selected days and invalid dates', () => {
  expect(validateDateRange({ from: '2024-01-01', to: '2025-01-01' }, '2025-01-02')).not.toBeNull()
  expect(validateDateRange({ from: '2024-02-30', to: '2024-03-01' })).not.toBeNull()
})
it('retains the legacy 30-day fallback for restored histories without an explicit warm-up boundary', async () => {
  const download = vi.fn(async range => fixtureHistory(range.from, range.to))
  const history = await new HistoryLoader(download).load({ from: '2024-03-01', to: '2025-03-01' }, new AbortController().signal, () => {})
  expect(download).toHaveBeenCalledWith({ from: '2024-01-31', to: '2025-03-01', tradingFrom: '2024-03-01' }, expect.any(AbortSignal))
  expect(history.tradingFrom).toBe('2024-03-01')
})
it('reads the complete cached interval with pre-roll in one non-billable request', async () => {
  const download = vi.fn(async range => fixtureHistory(range.from, range.to)), progress = vi.fn()
  const history = await new HistoryLoader(download).load({ from: '2024-01-09', to: '2024-01-11' }, new AbortController().signal, progress)
  expect(download).toHaveBeenCalledTimes(1)
  expect(download.mock.calls[0][0]).toEqual({ from: '2023-12-10', to: '2024-01-11', tradingFrom: '2024-01-09' })
  expect(history).toMatchObject({ tradingFrom: '2024-01-09', priceModel: 'single' })
  expect(progress).toHaveBeenLastCalledWith({ completed: 1, total: 1 })
})
it('does not retry failed cache reads or accept aborted results', async () => {
  const read = vi.fn(async () => { throw Error('Not cached') })
  await expect(new HistoryLoader(read).load({ from: '2024-01-09', to: '2024-01-11' }, new AbortController().signal, () => {})).rejects.toThrow('Not cached')
  expect(read).toHaveBeenCalledTimes(1)
  const controller = new AbortController()
  await expect(new HistoryLoader(async range => { controller.abort(); return fixtureHistory(range.from, range.to) }).load({ from: '2024-01-09', to: '2024-01-11' }, controller.signal, () => {})).rejects.toMatchObject({ name: 'AbortError' })
})
it('loads an observation-derived warm-up without reducing the forward replay range', async () => {
  const download = vi.fn(async range => fixtureHistory(range.from, range.to))
  const history = await new HistoryLoader(download).load({ from: '2024-04-01', to: '2024-09-28' }, new AbortController().signal, () => {}, '2024-01-03')
  expect(download.mock.calls[0][0]).toEqual({ from: '2024-01-03', tradingFrom: '2024-04-01', to: '2024-09-28' })
  expect(history).toMatchObject({ from: '2024-01-03', tradingFrom: '2024-04-01', to: '2024-09-28' })
})
it('measures D1 Ichimoku readiness from completed observed bars', () => {
  const start = Date.UTC(2024, 0, 9)
  const bars = Array.from({ length: 78 }, (_, i) => ({ timestamp: start - (78 - i) * 86_400_000, open: 1, high: 1, low: 1, close: 1 }))
  expect(ichimokuWarmup(bars, start)).toEqual({ count: 78, required: 78, ready: true })
  expect(ichimokuWarmup(bars.slice(1), start).ready).toBe(false)
  expect(replayStartIndex([...bars, { ...bars[0], timestamp: start + 60000 }], start)).toBe(78)
})
