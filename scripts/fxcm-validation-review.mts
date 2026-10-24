// Fixed-budget read-only provider audit. Never uses application/user storage.
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { writeFile } from 'node:fs/promises'
const BASE='https://candledata.fxcorporate.com/m1/EURUSD/'
const files=['2024/11.csv.gz',...Array.from({length:10},(_,i)=>`2026/${18+i}.csv.gz`),'2026/1.csv.gz','2026/37.csv.gz']
const results:any[]=[]
for(const file of files){
 const start=Date.now(),response=await fetch(BASE+file,{signal:AbortSignal.timeout(25000),redirect:'error'})
 const result:any={file,status:response.status}
 if(!response.ok){await response.body?.cancel();result.ms=Date.now()-start;results.push(result);continue}
 if(Number(response.headers.get('content-length'))>2*1024*1024)throw Error('Compressed limit')
 const reader=response.body!.getReader(),parts:Uint8Array[]=[];let size=0
 try{while(true){const{done,value}=await reader.read();if(done)break;size+=value.length;if(size>2*1024*1024){await reader.cancel();throw Error('Compressed limit')}parts.push(value)}}finally{reader.releaseLock()}
 const bytes=Buffer.concat(parts),lines=gunzipSync(bytes,{maxOutputLength:8*1024*1024}).toString().trimEnd().split(/\r?\n/)
 if(lines.shift()!=='DateTime,BidOpen,BidHigh,BidLow,BidClose,AskOpen,AskHigh,AskLow,AskClose')throw Error('Header')
 const utc=(s:string)=>{const m=/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):00\.000$/.exec(s);if(!m)throw Error('Timestamp');return new Date(Date.UTC(+m[3],+m[1]-1,+m[2],+m[4],+m[5])).toISOString()}
 Object.assign(result,{ms:Date.now()-start,bytes:size,sha256:createHash('sha256').update(bytes).digest('hex'),rows:lines.length,firstUtc:utc(lines[0].split(',')[0]),lastUtc:utc(lines.at(-1)!.split(',')[0])})
 if(file==='2024/11.csv.gz'){
  const crossed:any[]=[]
  for(const line of lines){const c=line.split(',');for(const[i,field]of ['open','high','low','close'].entries()){
   // Exact decimal subtraction at a common integer scale; no floating point cancellation.
   const b=c[1+i],a=c[5+i],scale=Math.max(b.split('.')[1]?.length??0,a.split('.')[1]?.length??0)
   const integer=(v:string)=>{const[whole,frac='']=v.split('.');return BigInt(whole+frac.padEnd(scale,'0'))}
   const delta=integer(b)-integer(a)
   if(delta>0n)crossed.push({utc:utc(c[0]),field,bidMinusAskPips:Number(delta)*10000/10**scale})
  }}
  Object.assign(result,{crossedRows:new Set(crossed.map(c=>c.utc)).size,crossedComponents:crossed,openOrCloseCrossedRows:new Set(crossed.filter(c=>c.field==='open'||c.field==='close').map(c=>c.utc)).size})
 }
 results.push(result);console.log(JSON.stringify(result))
}
await writeFile('docs/fxcm/review/archive-audit.json',JSON.stringify({checkedAt:new Date().toISOString(),requestBudget:13,requestsMade:results.length,retries:0,rawDatasetsCommitted:false,results},null,2))
