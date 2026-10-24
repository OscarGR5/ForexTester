import { createApp } from '../backend/src/app'
import { FxcmHistory } from '../backend/src/fxcm'
import { SessionStorage } from '../backend/src/sessionStorage'
import { HistoryLoader } from '../frontend/src/historyLoader'
import { parseHistory } from '../frontend/src/history'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
const dir=await mkdtemp(join(tmpdir(),'fxcm-throughput-'))
process.env.FOREXTESTER_CACHE_DIR=join(dir,'cache');process.env.FOREXTESTER_DATA_DIR=join(dir,'data')
const network:unknown[]=[],chunks:unknown[]=[];let active=0,maximumConcurrency=0
const fxcm=new FxcmHistory(async(input,init)=>{
 const start=Date.now();maximumConcurrency=Math.max(maximumConcurrency,++active)
 try{const response=await fetch(input,init);network.push({file:String(input).split('/EURUSD/')[1],status:response.status,ms:Date.now()-start,bytes:Number(response.headers.get('content-length'))});return response}finally{active--}
})
const api=createApp(undefined,undefined,new SessionStorage({directory:process.env.FOREXTESTER_DATA_DIR}),fxcm)
await new Promise<void>(r=>api.listen(0,'127.0.0.1',r));const port=(api.address() as {port:number}).port
const start=Date.now();let result:unknown
try{
 const loader=new HistoryLoader(async(range,signal,provider)=>{
  const t=Date.now(),response=await fetch(`http://127.0.0.1:${port}/api/history?${new URLSearchParams({...range,symbol:'EURUSD',provider:provider!})}`,{signal}),data=await response.json()
  if(!response.ok)throw Error(JSON.stringify(data))
  chunks.push({...range,ms:Date.now()-t,bid:data.bid.length,ask:data.ask.length});return parseHistory(data,range)
 })
 const history=await loader.load({from:'2024-01-09',to:'2024-04-08'},new AbortController().signal,()=>{},'fxcm')
 assert.equal(chunks.length,18);assert.equal(history.from,'2023-12-10');assert.equal(history.bid.length,history.ask.length)
 result={verified:true,ms:Date.now()-start,from:history.from,tradingFrom:history.tradingFrom,to:history.to,bid:history.bid.length,ask:history.ask.length,tradingCandles:history.bid.filter(b=>b.timestamp>=Date.parse(history.tradingFrom)).length,archives:history.provenance?.sources?.length,maximumConcurrency,chunks,network}
 console.log(JSON.stringify(result))
}catch(error){result={verified:false,ms:Date.now()-start,error:String(error),chunks,network};process.exitCode=1;console.error(result)}
finally{await writeFile('docs/fxcm/throughput-verification.json',JSON.stringify(result,null,2));await new Promise<void>(r=>api.close(()=>r()));await rm(dir,{recursive:true,force:true})}
