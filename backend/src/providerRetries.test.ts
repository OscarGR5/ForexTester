// Contract tests against the installed package. No provider requests or browser
// challenges run: the fetch transport is mocked for every case.
import { afterEach, expect, it, vi } from 'vitest'
import { BufferFetcher, RateLimitError, URL_ROOT, WafTokenError } from 'dukascopy-node'
const url = `${URL_ROOT}/candles/minute/EURUSD/BID/2024/0/9`
const validEmpty = JSON.stringify({timestamp:1704758400000,times:[],opens:[],highs:[],lows:[],closes:[],volumes:[]})
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks()})
function transport(){
  // 'off' applies only to this mocked transport so tests never launch a browser.
  return new BufferFetcher({wafMode:'off',wafTokenCache:false,retryCount:2,rateLimitRetryCount:3})
}
it('uses the installed 429 backoff and respects Retry-After before succeeding',async()=>{
  vi.useFakeTimers();vi.spyOn(Math,'random').mockReturnValue(0)
  const fetch=vi.fn().mockResolvedValueOnce(new Response('',{status:429,headers:{'retry-after':'12'}}))
    .mockResolvedValueOnce(new Response(validEmpty,{headers:{'content-type':'application/json'}}))
  vi.stubGlobal('fetch',fetch)
  const pending=transport().fetch([url])
  await vi.advanceTimersByTimeAsync(11999);expect(fetch).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(await pending).toHaveLength(1);expect(fetch).toHaveBeenCalledTimes(2)
})
it('bounds persistent rate limiting independently of generic retries',async()=>{
  vi.useFakeTimers();vi.spyOn(Math,'random').mockReturnValue(0)
  const fetch=vi.fn(async()=>new Response('',{status:429,headers:{'retry-after':'1'}}));vi.stubGlobal('fetch',fetch)
  const assertion=expect(transport().fetch([url])).rejects.toBeInstanceOf(RateLimitError)
  await vi.runAllTimersAsync();await assertion
  expect(fetch).toHaveBeenCalledTimes(4)
})
it('stops rather than shortening an excessive Retry-After',async()=>{
  vi.useFakeTimers()
  const fetch=vi.fn(async()=>new Response('',{status:429,headers:{'retry-after':'600'}}));vi.stubGlobal('fetch',fetch)
  await expect(transport().fetch([url])).rejects.toMatchObject({code:'DUKASCOPY_RATE_LIMIT',retryAfterMs:600000})
  expect(fetch).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0)
})
it('does not retry WafTokenError through generic retryCount',async()=>{
  const fetch=vi.fn().mockRejectedValue(new WafTokenError('Authorization unavailable'));vi.stubGlobal('fetch',fetch)
  await expect(transport().fetch([url])).rejects.toMatchObject({code:'DUKASCOPY_WAF_TOKEN'})
  expect(fetch).toHaveBeenCalledTimes(1)
})
