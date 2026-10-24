// Live diagnostic only. Fresh external caches and sessions; never print cookies,
// tokens, response bodies from the provider, or arbitrary error properties.
import { getHistoricalRates, defaultConfig } from 'dukascopy-node'
import { createApp } from '../backend/src/app'
import { SessionStorage } from '../backend/src/sessionStorage'
import { checkProviderBrowser } from '../backend/src/providerBrowser'
import { classifyHistoryError } from '../backend/src/historyCoverage'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const directory = await mkdtemp(join(tmpdir(), 'forextester-waf-'))
const mode = process.env.WAF_MODE ?? 'api'
const serialized = process.env.WAF_SERIALIZED === '1'
const output = process.env.WAF_EVIDENCE ?? `docs/task-20/waf-${mode}${serialized ? '-serialized' : ''}.json`
const evidence: any = { started: new Date().toISOString(), mode, serialized, sandbox: true,
  freshCachePerCase: true, defaults: { batchSize: defaultConfig.batchSize, pauseBetweenBatchesMs: defaultConfig.pauseBetweenBatchesMs,
    rateLimitRetryCount: defaultConfig.rateLimitRetryCount, retryCount: 2 }, preflight: null, cases: [] }
let statuses: unknown[] = [], calls: unknown[] = []
const nativeFetch = globalThis.fetch
// Collect only status metadata from Node requests, never headers carrying secrets.
globalThis.fetch = async (...args) => {
  const response = await nativeFetch(...args)
  if (new URL(String(args[0])).hostname.endsWith('.dukascopy.com')) statuses.push({ status: response.status,
    retryAfter: response.headers.get('retry-after'), action: response.headers.get('x-amzn-waf-action') })
  return response
}
function safeError(error: any): unknown {
  const message = String(error?.message ?? '')
  return { name: ['Error','WafTokenError','WafChallengeError','RateLimitError','TimeoutError','TypeError'].includes(error?.name) ? error.name : 'OtherError',
    code: ['DUKASCOPY_WAF_TOKEN','DUKASCOPY_WAF_CHALLENGE','DUKASCOPY_RATE_LIMIT','ECONNRESET','ETIMEDOUT','ENOTFOUND'].includes(error?.code) ? error.code : undefined,
    diagnostic: classifyHistoryError(error),
    // The installed token error embeds the last browser status only in its message.
    lastBrowserStatus: message.match(/last HTTP status: (\d+|none)/)?.[1],
    providerStatus: error?.status ?? message.match(/(?:HTTP |status )(\d{3})/)?.[1],
    wafAction: message.match(/WAF action: (challenge|captcha|none)/)?.[1],
    cause: error?.cause ? safeError(error.cause) : null }
}
async function download(config: Parameters<typeof getHistoricalRates>[0]) {
  const started = Date.now()
  try {
    const data = await getHistoricalRates({ ...config, ...(serialized ? {batchSize:1,pauseBetweenBatchesMs:1000,requestIntervalMs:1000} : {}) } as any) as any[]
    calls.push({ side: config.priceType, ms: Date.now()-started, count:data.length, first:data[0], last:data.at(-1) })
    return data
  } catch(error) { calls.push({side: config.priceType,ms:Date.now()-started,error:safeError(error)}); throw error }
}
const originalError = console.error
console.error = () => {} // The baseline backend logs arbitrary upstream objects.
let denials = 0
try {
  const start = Date.now()
  await checkProviderBrowser()
  evidence.preflight = { ok:true,ms:Date.now()-start }
  const ranges = process.env.WAF_FROM && process.env.WAF_TO ? [[process.env.WAF_FROM,process.env.WAF_TO]]
    : [ ['2026-09-17','2026-09-24'], ['2026-09-17','2026-09-18'], ['2024-01-09','2024-01-10'], ['2024-02-05','2024-02-06'] ]
  if (mode === 'direct') {
    for (const [from,to] of ranges) for (const side of ['bid','ask'] as const) {
      if (denials >= 2) { evidence.cases.push({from,to,side,skipped:'Stopped after two persistent authorization failures.'}); continue }
      const cache = await mkdtemp(join(directory, 'cache-')); statuses=[];calls=[]
      const start = Date.now()
      try {
        const data = await download({instrument:'eurusd',dates:{from:new Date(from),to:new Date(to)},timeframe:'m1',format:'json',priceType:side,
          utcOffset:0,useCache:true,cacheFolderPath:join(cache,'data')+'/',wafTokenCachePath:join(cache,'waf-token.json'),chromePath:resolve('scripts/provider-browser.sh'),retryCount:2})
        evidence.cases.push({from,to,side,ok:true,ms:Date.now()-start,count:data.length,calls,statuses})
      } catch(error) {
        const diagnostic=classifyHistoryError(error)
        if (diagnostic.code === 'PROVIDER_WAF' || diagnostic.code === 'PROVIDER_DENIED' || (error as Error)?.name === 'WafTokenError') denials++
        evidence.cases.push({from,to,side,ok:false,ms:Date.now()-start,error:safeError(error),calls,statuses})
      }
      console.log(JSON.stringify(evidence.cases.at(-1)))
      await writeFile(output,JSON.stringify(evidence,null,2)+'\n')
      await delay(2000)
    }
  } else if (mode === 'api') {
    for (const [from,to] of ranges) {
      if (denials >= 2) { evidence.cases.push({from,to,skipped:'Stopped after two persistent authorization failures.'}); continue }
      process.env.FOREXTESTER_CACHE_DIR=await mkdtemp(join(directory,'cache-'));statuses=[];calls=[]
      const app=createApp(download as any,undefined,new SessionStorage({directory:join(directory,`sessions-${from}-${to}`)}))
      await new Promise<void>(r=>app.listen(0,'127.0.0.1',r))
      const start=Date.now()
      try {
        const response=await fetch(`http://127.0.0.1:${(app.address() as any).port}/api/history?symbol=EURUSD&from=${from}&to=${to}`)
        const body=await response.json()
        if (body.code === 'PROVIDER_WAF' || body.code === 'PROVIDER_DENIED' || calls.some((call:any)=>call.error?.name==='WafTokenError')) denials++
        evidence.cases.push({from,to,ms:Date.now()-start,status:response.status,...(response.ok?{bid:body.bid.length,ask:body.ask.length}:{error:body}),calls,statuses})
      } finally { await new Promise<void>(r=>app.close(()=>r())) }
      console.log(JSON.stringify(evidence.cases.at(-1)))
      await writeFile(output,JSON.stringify(evidence,null,2)+'\n')
      await delay(2000)
    }
  } else throw Error('Use WAF_MODE=api or direct.')
} catch(error) {evidence.failure=safeError(error)}
finally {
  evidence.finished=new Date().toISOString()
  await writeFile(output,JSON.stringify(evidence,null,2)+'\n')
  console.error=originalError;globalThis.fetch=nativeFetch
  await rm(directory,{recursive:true,force:true})
}
