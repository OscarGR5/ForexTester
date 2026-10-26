import { afterEach,beforeEach,expect,it,vi } from 'vitest'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { createApp } from './app.js'
import { LocalArchive } from './localArchive.js'
import { SessionStorage } from './sessionStorage.js'
import { parquetFixture } from '../../tests/localForexFixture.js'
let root:string,server:Server,origin:string
beforeEach(async()=>{
 root=await mkdtemp(join(tmpdir(),'forex-local-api-'));const history=new LocalArchive(join(root,'data'))
 await history.importFile(await parquetFixture(root))
 server=createApp(history,undefined,new SessionStorage({directory:join(root,'sessions')}))
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`
})
afterEach(async()=>{await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections()});await rm(root,{recursive:true,force:true});vi.restoreAllMocks()})
it('discovers installed pairs, verified coverage and genuine calendar gaps',async()=>{
 const result=await (await fetch(`${origin}/api/history/datasets`)).json()
 expect(result.datasets[0]).toMatchObject({symbol:'EURUSD',priceBasis:'mid',tradingEnabled:true,timezone:'UTC'})
 expect(JSON.stringify(result)).not.toContain('.parquet');expect(JSON.stringify(result)).not.toContain(root)
 const calendar=await (await fetch(`${origin}/api/history/calendar?symbol=EURUSD`)).json()
 expect(calendar.days.find((d:any)=>d.date==='2024-01-06').status).toBe('gap')
})
it('loads only requested observations including pre-roll without any provider calls',async()=>{
 const response=await fetch(`${origin}/api/history?symbol=EURUSD&from=2024-01-02&tradingFrom=2024-02-01&to=2024-03-01`)
 expect(response.status).toBe(200)
 const result=await response.json();expect(result).toMatchObject({format:'local-forex-v1',symbol:'EURUSD',from:'2024-01-02',to:'2024-03-01',priceBasis:'mid'})
 expect(result.candles[0].timestamp).toBe(Date.UTC(2024,0,2))
})
it('removes pricing/download endpoints and rejects path input or cross-origin access',async()=>{
 for(const path of ['/api/history/estimate','/api/history/download'])expect((await fetch(origin+path,{method:path.endsWith('download')?'POST':'GET'})).status).toBe(404)
 expect((await fetch(`${origin}/api/history?symbol=EURUSD&path=/etc/passwd`)).status).toBe(400)
 expect((await fetch(`${origin}/api/history/calendar?symbol=../../etc/passwd`)).status).toBe(400)
 expect((await fetch(`${origin}/api/history/datasets`,{headers:{Origin:'https://example.com'}})).status).toBe(403)
})

it('starts on the first installed date with an equal history and replay boundary', async () => {
 const response=await fetch(`${origin}/api/history?symbol=EURUSD&from=2024-01-01&tradingFrom=2024-01-01&to=2024-01-02`)
 expect(response.status).toBe(200)
 const history=await response.json()
 expect(history).toMatchObject({from:'2024-01-01',to:'2024-01-02'})
 expect(history.candles[0].timestamp).toBe(Date.UTC(2024,0,1))
 expect((await fetch(`${origin}/api/history?symbol=EURUSD&from=2024-01-02&tradingFrom=2024-01-01&to=2024-01-03`)).status).toBe(400)
})
