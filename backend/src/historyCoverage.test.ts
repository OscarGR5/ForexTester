import { expect, it } from 'vitest'
import { instrumentMetaData } from 'dukascopy-node'
import { classifyHistoryError, historyCoverage, historyErrorDetails, verifiedDate } from './historyCoverage.js'
import { createApp } from './app.js'
it('returns installed metadata and provisional UTC boundaries without a claimed verification',async()=>{
 const app=createApp(undefined,()=>new Date('2024-01-20T23:59:59-05:00'))
 await new Promise<void>(r=>app.listen(0,'127.0.0.1',r))
 try {
 const response=await fetch(`http://127.0.0.1:${(app.address() as {port:number}).port}/api/history/coverage`)
 const result=await response.json();expect(result.providerEarliestTimestamp).toBe(instrumentMetaData.eurusd.startDayForMinuteCandles)
 expect(result.latestEligibleDate).toBe('2024-01-20');expect(result.latestBoundaryProvisional).toBe(true)
 expect(result.lastVerifiedAvailableDate).toBeNull();expect(result.providerHealth.status).toBe('unknown')
 }finally{await new Promise<void>(r=>app.close(()=>r()))}
})
it.each([
 [Object.assign(new Error('private cookie=secret'), {name:'RateLimitError',code:'DUKASCOPY_RATE_LIMIT',status:429,retryAfterMs:12000}), 'PROVIDER_RATE_LIMIT'],
 [Object.assign(new Error('Headless browser could not acquire a WAF token (last HTTP status: 429, WAF action: none)'),{name:'WafTokenError'}), 'PROVIDER_RATE_LIMIT'],
 [Object.assign(new Error('Headless browser could not acquire a WAF token (last HTTP status: 503, WAF action: none)'),{name:'WafTokenError'}), 'PROVIDER_UNAVAILABLE'],
 [new Error('Request failed with status 503 for provider'), 'PROVIDER_UNAVAILABLE'],
 [new Error('Request failed with status 403 for provider'), 'PROVIDER_DENIED'],
 [Object.assign(new Error('HTTP 403'), {name:'WafChallengeError',code:'DUKASCOPY_WAF_CHALLENGE'}), 'PROVIDER_WAF'],
 [new Error('fetch failed', {cause:Object.assign(new Error('secret'),{code:'ENOTFOUND'})}), 'PROVIDER_NETWORK'],
 [Object.assign(new Error('private token'),{name:'TokenValidationError'}), 'HISTORY_UNAVAILABLE'],
])('classifies structured and nested provider errors separately: %s', (error,code)=>{
 expect(classifyHistoryError(new Error('History retrieval failed',{cause:error})).code).toBe(code)
 expect(JSON.stringify(classifyHistoryError(error))).not.toMatch(/private|cookie=secret/)
})
it('retains a valid provider retry delay without inventing one or shortening a long wait',()=>{
 const error=Object.assign(new Error('limit'),{code:'DUKASCOPY_RATE_LIMIT',retryAfterMs:600000})
 expect(classifyHistoryError(error).retryAfterMs).toBe(600000)
 expect(classifyHistoryError({...error,retryAfterMs:-1}).retryAfterMs).toBeUndefined()
 expect(classifyHistoryError({...error,retryAfterMs:NaN}).retryAfterMs).toBeUndefined()
 expect(classifyHistoryError(new Error('status 429')).retryAfterMs).toBeUndefined()
})
it('logs only allowlisted diagnostic fields, including bounded cyclic causes',()=>{
 const error=Object.assign(new Error('token=secret cookie=secret (last HTTP status: 202, WAF action: challenge)'),
  {name:'WafTokenError',code:'DUKASCOPY_WAF_TOKEN',headers:{cookie:'secret'},token:'secret',cause:null as unknown})
 error.cause=error
 expect(historyErrorDetails(error)).toEqual([{name:'WafTokenError',code:'DUKASCOPY_WAF_TOKEN',status:202,wafAction:'challenge'}])
 expect(JSON.stringify(historyErrorDetails(error))).not.toContain('secret')
 expect(classifyHistoryError(error).code).toBe('PROVIDER_WAF')
})
it.each([
 ['WafTokenError','Could not launch headless chrome. Run setup.','BROWSER_UNAVAILABLE'],
 ['WafTokenError','Could not launch headless browser. Browser system dependencies are missing.','BROWSER_DEPENDENCIES'],
 ['Error','error while loading shared libraries: libnss3.so','BROWSER_DEPENDENCIES'],
 ['WafTokenError','Headless browser could not acquire a WAF token (last HTTP status: 202)','PROVIDER_WAF'],
 ['Error','fetch failed: ECONNRESET','PROVIDER_NETWORK'],
 ['Error','Provider failure containing private stack detail','HISTORY_UNAVAILABLE'],
])('classifies realistic %s errors without leaking details', (name,message,code)=>{
 const error=new Error(message);error.name=name
 const result=classifyHistoryError(error);expect(result.code).toBe(code);expect(result.action.length).toBeGreaterThan(10)
 expect(JSON.stringify(result)).not.toContain('private stack')
})
it('only claims a date containing synchronized bid and ask observations',()=>{
 const candle=(date:string)=>({timestamp:Date.parse(date),open:1,high:1,low:1,close:1})
 const data={symbol:'EURUSD' as const,resolution:'M1' as const,from:'2024-01-01',to:'2024-01-04',bid:[candle('2024-01-01'),candle('2024-01-03')],ask:[candle('2024-01-01')]}
 expect(verifiedDate(data)).toBe('2024-01-01');expect(verifiedDate({...data,ask:[]})).toBeNull()
 expect(historyCoverage(new Date('2024-01-01T00:00:00Z')).latestEligibleDate).toBe('2023-12-31')
})
