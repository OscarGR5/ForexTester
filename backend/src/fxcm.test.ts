import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { gzipSync } from 'node:zlib'
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { archiveCandidates, FxcmHistory, parseFxcmArchive } from './fxcm.js'
const header = 'DateTime,BidOpen,BidHigh,BidLow,BidClose,AskOpen,AskHigh,AskLow,AskClose'
const row = (date: string, prices='1.1,1.2,1.0,1.11,1.101,1.201,1.001,1.111') => `${date},${prices}`
const archive = (...rows: string[]) => gzipSync(`${header}\n${rows.join('\n')}\n`)
const jan = archive(row('01/07/2024 22:08:00.000'),row('01/09/2024 00:00:00.000'),row('01/09/2024 00:02:00.000'),row('01/12/2024 21:59:00.000'))
let cache: string
beforeEach(async()=>{cache=await mkdtemp(join(tmpdir(),'fxcm-test-'));vi.stubEnv('FOREXTESTER_CACHE_DIR',cache)})
afterEach(async()=>{vi.unstubAllEnvs();await rm(cache,{recursive:true,force:true})})
const downloader = (files: Record<string, Uint8Array>) => vi.fn<typeof fetch>(async input => {
  const file=String(input).split('/EURUSD/')[1]
  return files[file] ? new Response(files[file] as BodyInit) : new Response('missing',{status:404})
})
it('discovers January 2024 by actual UTC contents and preserves distinct sides and missing minutes',async()=>{
 const fetch=downloader({'2024/2.csv.gz':jan}),data=await new FxcmHistory(fetch).load('2024-01-09','2024-01-10')
 expect(data.bid.map(b=>b.timestamp)).toEqual([Date.UTC(2024,0,9),Date.UTC(2024,0,9,0,2)])
 expect(data.bid[0].open).toBe(1.1);expect(data.ask[0].open).toBe(1.101)
 expect(data.provenance).toMatchObject({provider:'fxcm',version:2,sources:[{file:'2024/2.csv.gz'}]})
})
it.each([
 ['2024-01-01','2024-01-02','2023/53.csv.gz','01/01/2024 00:00:00.000'],
 ['2026-01-01','2026-01-02','2025/53.csv.gz','01/01/2026 00:00:00.000'],
 ['2026-01-05','2026-01-06','2026/1.csv.gz','01/05/2026 00:00:00.000'],
])('validates the cross-year mapping for %s',async(from,to,file,time)=>{
 const fetch=downloader({[file]:archive(row(time))}),data=await new FxcmHistory(fetch).load(from,to)
 expect(data.bid).toHaveLength(1);expect(data.provenance?.sources?.[0].file).toBe(file)
 expect(fetch.mock.calls.length).toBeLessThanOrEqual(7)
})
it('loads September 17–24 across shifted files and partial weeks without filling closures',async()=>{
 const fetch=downloader({'2026/37.csv.gz':archive(row('09/17/2026 00:00:00.000'),row('09/18/2026 20:58:00.000')),
 '2026/38.csv.gz':archive(row('09/20/2026 21:03:00.000'),row('09/24/2026 22:27:00.000'),row('09/25/2026 20:59:00.000'))})
 const service=new FxcmHistory(fetch)
 const first=await service.load('2026-09-17','2026-09-24'),last=await service.load('2026-09-24','2026-09-25')
 expect(first.bid).toHaveLength(3);expect(last.bid).toHaveLength(1)
 expect(first.bid.at(-1)?.timestamp).toBe(Date.UTC(2026,8,20,21,3))
 expect(first.provenance?.sources?.map(s=>s.file)).toEqual(['2026/37.csv.gz','2026/38.csv.gz'])
})
it('validates archive contents rather than accepting an existing wrong-week filename',async()=>{
 const fetch=downloader({'2026/38.csv.gz':archive(row('09/21/2026 00:00:00.000'))})
 await expect(new FxcmHistory(fetch).load('2026-09-17','2026-09-18')).rejects.toMatchObject({code:'FXCM_MISSING'})
 expect(fetch).toHaveBeenCalledTimes(5)
})
it('does not treat a missing or unpublished required week as a successful empty interval',async()=>{
 const fetch=downloader({}),service=new FxcmHistory(fetch,()=>new Date('2026-10-24'))
 await expect(service.load('2026-10-22','2026-10-23')).rejects.toMatchObject({code:'FXCM_UNPUBLISHED'})
 await expect(service.load('2024-01-09','2024-01-10')).rejects.toMatchObject({code:'FXCM_MISSING'})
 expect((await readdir(join(cache,'fxcm')))).toEqual([])
})
it('allows a weekend empty interval only after observing its published weekly archive',async()=>{
 const data=await new FxcmHistory(downloader({'2024/2.csv.gz':jan})).load('2024-01-13','2024-01-14')
 expect(data.bid).toEqual([]);expect(data.provenance?.sources).toHaveLength(1)
})
it.each([
 Buffer.from('not gzip'),gzipSync('bad header'),archive(),
 archive(row('02/30/2024 00:00:00.000')),
 archive(row('01/09/2024 24:00:00.000')),
 archive(row('01/09/2024 00:00:01.000')),
 archive(row('01/09/2024 00:00:00.000','NaN,1.2,1,1.1,1.2,1.3,1.1,1.2')),
 archive(row('01/09/2024 00:00:00.000','1.1,1.01,1,1.1,1.2,1.3,1.1,1.2')),
 archive(row('01/09/2024 00:00:00.000','1.1,1.2,1,1.1,1.0,1.3,1.1,1.2')),
 archive(row('01/09/2024 00:00:00.000'),row('01/09/2024 00:00:00.000')),
 archive(row('01/09/2024 00:00:00.000'),row('01/09/2024 00:00:00.000','1.12,1.2,1,1.11,1.13,1.21,1.01,1.12')),
 archive(row('01/09/2024 00:02:00.000'),row('01/09/2024 00:00:00.000')),
 archive(row('01/09/2024 00:00:00.000'),row('01/16/2024 00:00:00.000')),
 gzipSync('x'.repeat(8*1024*1024+1)),
])('rejects malformed, inconsistent, duplicate, unordered or oversized archives %#',bytes=>{
 expect(()=>parseFxcmArchive(bytes)).toThrow('invalid archive')
})
it('shares concurrent archive downloads, namespaces disk cache, and reuses it after restart',async()=>{
 const fetch=downloader({'2024/2.csv.gz':jan}),service=new FxcmHistory(fetch)
 await Promise.all([service.load('2024-01-09','2024-01-10'),service.load('2024-01-10','2024-01-11')])
 expect(fetch.mock.calls.filter(([url])=>String(url).endsWith('/2024/2.csv.gz'))).toHaveLength(1)
 const files=await readdir(join(cache,'fxcm'));expect(files).toHaveLength(1);expect(files[0]).toContain('m1-bid-ask-v1')
 const restarted=new FxcmHistory(downloader({}))
 expect((await restarted.load('2024-01-09','2024-01-10')).bid).toHaveLength(2)
})
it('rejects HTTP errors and retries a failed download only when requested again',async()=>{
 let failed=true
 const fetch=vi.fn<typeof globalThis.fetch>(async()=>{if(failed)throw Error('network secret');return new Response(jan)})
 const service=new FxcmHistory(fetch)
 await expect(service.load('2024-01-09','2024-01-10')).rejects.toMatchObject({code:'FXCM_NETWORK'})
 failed=false;expect((await service.load('2024-01-09','2024-01-10')).bid).toHaveLength(2)
})
it('bounds both declared and streamed download sizes',async()=>{
 for(const response of [new Response('small',{headers:{'Content-Length':String(3*1024*1024)}}),new Response(new Uint8Array(2*1024*1024+1))]) {
  await expect(new FxcmHistory(vi.fn(async()=>response)).load('2024-01-09','2024-01-10')).rejects.toMatchObject({code:'FXCM_INVALID'})
 }
})
it('keeps a corrupt cached archive visible as an error rather than silently redownloading',async()=>{
 const fetch=downloader({'2024/2.csv.gz':jan});await new FxcmHistory(fetch).load('2024-01-09','2024-01-10')
 const path=join(cache,'fxcm',(await readdir(join(cache,'fxcm')))[0]);await writeFile(path,'invalid')
 await expect(new FxcmHistory(fetch).load('2024-01-09','2024-01-10')).rejects.toMatchObject({code:'FXCM_INVALID'})
})
it('bounds candidate discovery independently of the date year',()=>{
 for(const date of ['2024-01-07','2023-12-31','2025-12-28','2026-09-13']) expect(archiveCandidates(Date.parse(date)).length).toBeLessThanOrEqual(7)
})
it('bounds network concurrency to two even with multiple independent API clients',async()=>{
 let active=0,maximum=0
 const files:Record<string,Uint8Array>={}
 for(const [week,date] of [[2,'01/09/2024'],[3,'01/16/2024'],[4,'01/23/2024'],[5,'01/30/2024']] as const)files[`2024/${week}.csv.gz`]=archive(row(`${date} 00:00:00.000`))
 const fetch=vi.fn<typeof globalThis.fetch>(async(input)=>{
  maximum=Math.max(maximum,++active);await new Promise(resolve=>setTimeout(resolve,5));active--
  return new Response(files[String(input).split('/EURUSD/')[1]] as BodyInit)
 })
 const service=new FxcmHistory(fetch)
 await Promise.all([['2024-01-09','2024-01-10'],['2024-01-16','2024-01-17'],['2024-01-23','2024-01-24'],['2024-01-30','2024-01-31']].map(([from,to])=>service.load(from,to)))
 expect(maximum).toBe(2);expect(fetch).toHaveBeenCalledTimes(4)
})
