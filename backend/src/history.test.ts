import { expect, it, vi } from 'vitest'
import { type RatesFetcher, loadHistory } from './history.js'

it('returns empty real history before the documented provider boundary without a download', async () => {
  const fetchRates=vi.fn<RatesFetcher>(async()=>[])
  expect(await loadHistory('2003-04-01','2003-04-08',fetchRates)).toMatchObject({bid:[],ask:[]})
  expect(fetchRates).not.toHaveBeenCalled()
})
it('clips a boundary-crossing provider download while preserving requested response dates', async () => {
  const fetchRates=vi.fn<RatesFetcher>(async()=>[])
  const history=await loadHistory('2003-05-01','2003-05-08',fetchRates)
  expect(history.from).toBe('2003-05-01')
  expect(fetchRates.mock.calls[0][0].dates.from).toEqual(new Date('2003-05-04T19:00:00Z'))
  expect(fetchRates.mock.calls[0][0].dates.to).toEqual(new Date('2003-05-08T00:00:00Z'))
})
