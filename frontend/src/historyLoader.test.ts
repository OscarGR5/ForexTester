import { describe, expect, it, vi } from 'vitest'
import { HistoryLoader, historyChunks, ichimokuWarmup, mergeCandles, replayStartIndex } from './historyLoader'
import { fetchHistory, HistoryRequestError, validateDateRange, type DateRange, type HistoryResponse } from './history'

const response = (range: DateRange): HistoryResponse => ({symbol:'EURUSD',resolution:'M1',...range,bid:[],ask:[]})
const bar = (timestamp: number) => ({timestamp,open:1.1,high:1.2,low:1,close:1.1})

describe('90 completed UTC days and warm-up chunks', () => {
  for (const days of [1,7,30,90]) it(`accepts ${days} calendar days`, () => {
    expect(validateDateRange({from:'2024-01-01',to:new Date(Date.UTC(2024,0,1+days)).toISOString().slice(0,10)},'2025-01-01')).toBeNull()
  })
  it('rejects 91 days, invalid dates, future periods, reversed and zero intervals', () => {
    for (const range of [{from:'2024-01-01',to:'2024-04-01'}, {from:'2023-02-29',to:'2023-03-01'},
      {from:'2024-01-01',to:'2025-01-02'},{from:'2024-01-02',to:'2024-01-01'}, {from:'2024-01-01',to:'2024-01-01'}]) {
      expect(validateDateRange(range,'2025-01-01')).not.toBeNull()
    }
  })
  it('splits month/year and leap boundaries chronologically without overlap', () => {
    expect(historyChunks({from:'2023-12-28',to:'2024-01-12'})).toEqual([
      {from:'2023-12-28',to:'2024-01-04'}, {from:'2024-01-04',to:'2024-01-11'}, {from:'2024-01-11',to:'2024-01-12'}])
    expect(historyChunks({from:'2024-02-26',to:'2024-03-05'})).toEqual([{from:'2024-02-26',to:'2024-03-04'},{from:'2024-03-04',to:'2024-03-05'}])
  })
  it('merges independent sides, accepts identical duplicates and preserves weekend gaps', () => {
    const friday=bar(Date.UTC(2024,0,5,21)), monday=bar(Date.UTC(2024,0,8))
    expect(mergeCandles([[monday],[friday,friday]])).toEqual([friday,monday])
    expect(() => mergeCandles([[friday],[{...friday,close:1.11}]])).toThrow('Conflicting')
  })
  it('uses at most two downloads, includes year-crossing pre-roll, and reuses successful chunks', async () => {
    let concurrent=0, maximum=0
    const download=vi.fn(async (range: DateRange) => {
      maximum=Math.max(maximum,++concurrent)
      await new Promise(resolve=>setTimeout(resolve,0)); concurrent--
      const candle=bar(Date.parse(range.from))
      return {...response(range),bid:[candle],ask:[{...candle,open:1.11,close:1.11}]}
    })
    const loader=new HistoryLoader(download), progress=vi.fn(), signal=new AbortController().signal
    const result=await loader.load({from:'2024-01-09',to:'2024-02-08'},signal,progress)
    expect(maximum).toBe(2)
    expect(result.from).toBe('2023-12-10'); expect(result.tradingFrom).toBe('2024-01-09')
    expect(result.bid).toHaveLength(10); expect(result.ask[0].close).toBe(1.11)
    expect(progress).toHaveBeenLastCalledWith({completed:10,total:10})
    await loader.load({from:'2024-01-09',to:'2024-02-08'},signal,progress)
    expect(download).toHaveBeenCalledTimes(10)
  })
  it('fails the entire interval and retries only unfinished chunks', async () => {
    let fail=true
    const download=vi.fn(async (range: DateRange) => { if(fail && range.from==='2023-12-17') throw Error('provider secret'); return response(range) })
    const loader=new HistoryLoader(download), range={from:'2024-01-09',to:'2024-01-10'}, signal=new AbortController().signal
    await expect(loader.load(range,signal,()=>{})).rejects.toThrow('Chunk 2/6 (2023-12-17 to 2023-12-24 UTC) failed')
    fail=false
    await expect(loader.load(range,signal,()=>{})).resolves.toMatchObject({tradingFrom:range.from})
    expect(download.mock.calls.filter(([range])=>range.from==='2023-12-10')).toHaveLength(1)
  })
  it('validates every chunk before caching and never accepts an aborted result', async () => {
    const invalid=new HistoryLoader(async range=>({...response(range),bid:[bar(0)]}))
    await expect(invalid.load({from:'2024-01-09',to:'2024-01-10'},new AbortController().signal,()=>{})).rejects.toThrow('failed')
    const controller=new AbortController()
    const loader=new HistoryLoader(async range=>{controller.abort();return response(range)})
    await expect(loader.load({from:'2024-01-09',to:'2024-01-10'},controller.signal,()=>{})).rejects.toMatchObject({name:'AbortError'})
  })
  it('recovers from transient authorization failure only on explicit retry, preserving completed chunks',async()=>{
    let fail=true
    const download=vi.fn(async(range:DateRange)=>{
      if(fail&&range.from==='2023-12-17')throw new HistoryRequestError('Dukascopy could not authorize this historical download.','PROVIDER_WAF','Provider authorization unavailable')
      const candle=bar(Date.parse(range.from))
      return {...response(range),bid:[candle],ask:[{...candle,open:1.11,close:1.11}]}
    })
    const loader=new HistoryLoader(download),range={from:'2024-01-09',to:'2024-01-10'},signal=new AbortController().signal
    await expect(loader.load(range,signal,()=>{})).rejects.toMatchObject({code:'PROVIDER_WAF',title:'Provider authorization unavailable'})
    const completed=download.mock.calls.filter(([r])=>r.from!=='2023-12-17').map(([r])=>r.from)
    fail=false
    const data=await loader.load(range,signal,()=>{})
    for(const from of completed)expect(download.mock.calls.filter(([r])=>r.from===from)).toHaveLength(1)
    expect(data.bid).toHaveLength(6);expect(data.ask).toHaveLength(6)
    expect(new Set(data.bid.map(c=>c.timestamp)).size).toBe(6)
    expect(data.ask.every(c=>c.open===1.11)).toBe(true)
  })
  it('bounds persistent authorization failures to the already running two workers with no automatic retry',async()=>{
    const download=vi.fn(async()=>{throw new HistoryRequestError('Authorization unavailable.','PROVIDER_WAF')})
    const loader=new HistoryLoader(download)
    await expect(loader.load({from:'2024-01-09',to:'2024-04-08'},new AbortController().signal,()=>{})).rejects.toMatchObject({code:'PROVIDER_WAF'})
    expect(download).toHaveBeenCalledTimes(2)
  })
  it('preserves rate limit advice and does not automatically repeat an exhausted provider retry budget',async()=>{
    const download=vi.fn(async()=>{throw new HistoryRequestError('Wait before retrying.','PROVIDER_RATE_LIMIT','Provider rate limit reached',12000)})
    await expect(new HistoryLoader(download).load({from:'2024-01-09',to:'2024-01-10'},new AbortController().signal,()=>{})).rejects.toMatchObject({code:'PROVIDER_RATE_LIMIT',retryAfterMs:12000})
    expect(download).toHaveBeenCalledTimes(2)
  })
  it('cancels promptly while a provider request is still waiting in its retry delay',async()=>{
    vi.useFakeTimers()
    // Model the HTTP request held open by dukascopy-node's internal 429 backoff.
    const fetch=vi.fn((_url:unknown,options?:RequestInit)=>new Promise<Response>((resolve,reject)=>{
      const timer=setTimeout(()=>resolve(new Response('{}')),60000)
      options?.signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(options.signal!.reason)},{once:true})
    }))
    vi.stubGlobal('fetch',fetch)
    try {
      const loader=new HistoryLoader(fetchHistory),controller=new AbortController()
      const pending=loader.load({from:'2024-01-09',to:'2024-01-10'},controller.signal,()=>{})
      const assertion=expect(pending).rejects.toMatchObject({name:'AbortError'})
      controller.abort();await assertion
      expect(fetch).toHaveBeenCalledTimes(2);expect(vi.getTimerCount()).toBe(0)
    } finally {vi.useRealTimers();vi.unstubAllGlobals()}
  })
  it('measures default H4 readiness from observations including displaced cloud', () => {
    const start=Date.UTC(2024,0,9)
    const candles=Array.from({length:78},(_,i)=>bar(start-(78-i)*14_400_000))
    expect(ichimokuWarmup(candles,start)).toEqual({count:78,required:78,ready:true})
    expect(ichimokuWarmup(candles.slice(1),start).ready).toBe(false)
    expect(ichimokuWarmup([],start).ready).toBe(false)
    expect(replayStartIndex([...candles,bar(start+60_000)],start)).toBe(78)
  })
})
