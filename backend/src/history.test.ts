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

it('keeps independent simultaneous callers and ordered bid/ask observations',async()=>{
  let active=0,maximum=0
  const fetchRates=vi.fn<RatesFetcher>(async config=>{
    maximum=Math.max(maximum,++active)
    await new Promise(r=>setTimeout(r,0));active--
    const open=config.priceType==='bid'?1.1:1.2
    return [{timestamp:Date.parse(String(config.dates.from)),open,high:open,low:open,close:open}]
  })
  const results=await Promise.all([loadHistory('2026-09-17','2026-09-18',fetchRates),loadHistory('2024-01-09','2024-01-10',fetchRates)])
  expect(maximum).toBe(2)
  for(const result of results){expect(result.bid[0].open).toBe(1.1);expect(result.ask[0].open).toBe(1.2)}
  expect(fetchRates.mock.calls.map(([c])=>c.priceType)).toEqual(['bid','bid','ask','ask'])
})
