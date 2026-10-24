// Real FXCM, real Chromium and React; all cache, browser and durable data are temporary.
import { chromium } from 'playwright-core'
import { createServer } from 'vite'
import { createApp } from '../backend/src/app'
import { SessionStorage } from '../backend/src/sessionStorage'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
const isolated=await mkdtemp(join(tmpdir(),'forextester-fxcm-live-'))
process.env.FOREXTESTER_CACHE_DIR=join(isolated,'cache')
process.env.FOREXTESTER_DATA_DIR=join(isolated,'data')
const storage=new SessionStorage({directory:process.env.FOREXTESTER_DATA_DIR})
const api=createApp(undefined,undefined,storage)
await new Promise<void>(r=>api.listen(0,'127.0.0.1',r));const port=(api.address() as {port:number}).port
const vite=await createServer({configFile:false,root:'frontend',cacheDir:join(isolated,'vite'),optimizeDeps:{include:['react','react-dom','react-dom/client','lightweight-charts','technicalindicators']},server:{watch:null,hmr:false,host:'127.0.0.1',port:5194,strictPort:true,proxy:{'/api':{target:`http://127.0.0.1:${port}`,changeOrigin:false}}}});await vite.listen()
const browser=await chromium.launch({channel:'chromium',chromiumSandbox:true})
const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage()
await page.addInitScript('globalThis.__name = (target) => target')
const errors:string[]=[],requests:unknown[]=[],results:unknown[]=[]
page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept())
page.on('response',async r=>{if(new URL(r.url()).pathname==='/api/history'){
 const data=await r.json().catch(()=>({})),params=new URL(r.url()).searchParams
 const evidence={from:params.get('from'),to:params.get('to'),provider:params.get('provider'),status:r.status(),bid:data.bid?.length,ask:data.ask?.length,error:data.error}
 requests.push(evidence);console.log(JSON.stringify(evidence))
}})
const button=(name:string)=>page.getByRole('button',{name,exact:true})
const saved=()=>page.waitForFunction(()=>document.querySelector('.save-state')?.textContent==='Saved')
const record=async()=>{await saved();const rows=(await storage.list()).sessions;assert.ok(rows.length);return rows[0]}
let failure: string | null=null
try {
 await page.goto('http://127.0.0.1:5194');await page.waitForFunction(()=>!document.querySelector<HTMLFieldSetElement>('.workspace-controls')?.disabled)
 assert.equal(requests.length,0)
 assert.equal(await page.getByLabel('Historical data provider').inputValue(),'dukascopy')
 await page.getByLabel('Historical data provider').selectOption('fxcm')
 await page.waitForFunction(()=>document.querySelector('.coverage-summary'))
 for (const [label,from,through,expected] of [['january','2024-01-09','2024-01-09',1438],['september','2026-09-17','2026-09-24',8628]] as const) {
  if(label!=='january') {await button('Sessions / settings').click();await button('New session').click();await page.getByRole('heading',{name:'Set up a backtest'}).waitFor();assert.equal(await page.getByLabel('Historical data provider').inputValue(),'dukascopy');await page.getByLabel('Historical data provider').selectOption('fxcm');await page.waitForFunction(()=>document.querySelector('.coverage-summary'))}
  await page.getByLabel('Backtest name',{exact:true}).fill(`FXCM ${label} live verification`)
  await page.getByLabel('From',{exact:true}).fill(from);await page.getByLabel('Through',{exact:true}).fill(through)
  const started=Date.now();await button('Load historical data').click()
  await page.waitForFunction(()=>document.querySelector('.data-ready')||document.querySelector('.load-error'),{},{timeout:300000})
  assert.equal(await page.locator('.load-error').count(),0,await page.locator('body').innerText())
  const loadMs=Date.now()-started;let sourceRecord=await record(),history=await storage.getHistory(sourceRecord.historyId)
  assert.equal(history.provenance?.provider,'fxcm');assert.equal(history.bid.filter(b=>b.timestamp>=Date.parse(from)).length,expected)
  for(const [width,height] of [[1440,900],[390,844]]){
   await page.setViewportSize({width,height});await page.screenshot({path:`docs/fxcm/${label}-setup-${width}.png`,fullPage:true})
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width)
  }
  await page.setViewportSize({width:1440,height:900});await button('Start backtest').click();await page.locator('.chart-canvas canvas').first().waitFor();await saved()
  assert.match(await page.locator('.replay-strip').innerText(),/FXCM/)
  await button('Play').click();await button('Pause').click();await saved()
  await page.getByLabel('Sizing mode').selectOption('manual');await page.getByLabel('Volume (lots)').fill('0.01')
  for(const direction of ['buy','sell'] as const){
   sourceRecord=await record();const quote=sourceRecord.checkpoint.trading.quote!;assert.ok(quote.ask)
   await button(direction==='buy'?'Buy':'Sell').click();await page.getByText('Enter price with keyboard',{exact:true}).click()
   await page.getByLabel('SL price').fill(String(direction==='buy'?quote.bid.low-.01:quote.ask.high+.01));await button('Confirm order').click()
   const requested=(await record()).checkpoint.trading.pending.at(-1)!;assert.equal(requested.direction,direction)
   await button('Next Candle').click();sourceRecord=await record()
   const position=sourceRecord.checkpoint.trading.positions.find(p=>p.direction===direction);assert.ok(position)
   const side=direction==='buy'?history.ask:history.bid,bar=side.find(b=>b.timestamp===position.entryTime);assert.ok(bar);assert.equal(position.entryPrice,bar.open)
   results.push({label,direction,entryTime:position.entryTime,price:position.entryPrice,side:direction==='buy'?'ask.open':'bid.open'})
  }
  await page.screenshot({path:`docs/fxcm/${label}-trading.png`,fullPage:true})
  await button('Finish backtest').click();await page.getByRole('heading',{name:/Backtest results/}).waitFor();await saved();await button('Save now').click();await saved()
  sourceRecord=await record();const before=sourceRecord.digest,historyId=sourceRecord.historyId,checkpoint=JSON.stringify(sourceRecord.checkpoint)
  assert.equal(sourceRecord.checkpoint.lifecycle,'finished');assert.equal(sourceRecord.checkpoint.trading.positions.length,2)
  const count=requests.length;await page.reload();await button('Resume session').first().click();await page.getByRole('heading',{name:/Backtest results/}).waitFor();await saved()
  assert.equal(requests.length,count);const restored=await storage.get(sourceRecord.id)
  assert.equal(restored.historyId,historyId);assert.equal(JSON.stringify(restored.checkpoint),checkpoint)
  await page.screenshot({path:`docs/fxcm/${label}-restored.png`,fullPage:true})
  results.push({label,from,through,loadMs,bid:history.bid.length,ask:history.ask.length,tradingObservations:expected,archives:history.provenance?.sources,historyId,originalDigest:before,restoreWithoutDownload:true,checkpointPreserved:true})
 }
 // Realistic maximum selection: 90 days plus 30 days of pre-roll, two workers.
 await button('Sessions / settings').click();await button('New session').click()
 await page.getByLabel('Historical data provider').selectOption('fxcm');await page.waitForFunction(()=>document.querySelector('.coverage-summary'))
 await page.getByLabel('From',{exact:true}).fill('2026-06-27');await page.getByLabel('Through',{exact:true}).fill('2026-09-24')
 const start=Date.now();await button('Load historical data').click()
 await page.waitForFunction(()=>document.querySelector('.data-ready')||document.querySelector('.load-error'),{},{timeout:300000})
 if(await page.locator('.load-error').count()) {
  results.push({label:'90-day-plus-preroll',loadMs:Date.now()-start,verified:false,error:await page.locator('.load-error').innerText(),incompleteDatasetRejected:await button('Start backtest').isDisabled()})
 } else {
  const maximumMs=Date.now()-start,maximum=await record(),maximumHistory=await storage.getHistory(maximum.historyId)
  results.push({label:'90-day-plus-preroll',verified:true,loadMs:maximumMs,bid:maximumHistory.bid.length,ask:maximumHistory.ask.length,archives:maximumHistory.provenance?.sources?.length,from:maximumHistory.from,to:maximumHistory.to})
  assert.equal(maximumHistory.from,'2026-05-28')
 }
 assert.deepEqual(errors,[])
 await storage.close()
 const restarted=new SessionStorage({directory:process.env.FOREXTESTER_DATA_DIR})
 try{for(const row of (await restarted.list()).sessions){const data=await restarted.getHistory(row.historyId);assert.equal(data.provenance?.provider,'fxcm');assert.equal(data.bid.length,row.totalCandles);await restarted.restore(row.id)}results.push({backendRestartRestore:true,sessions:(await restarted.list()).sessions.length})}finally{await restarted.close()}
} catch(error) { failure=error instanceof Error?error.message:String(error);console.error(failure);await page.screenshot({path:'docs/fxcm/live-failure.png',fullPage:true}).catch(()=>{});process.exitCode=1 }
finally {
 await writeFile('docs/fxcm/live-verification.json',JSON.stringify({date:new Date().toISOString(),sandbox:true,freshIsolatedCacheAndStorage:true,requests,results,errors,failure},null,2))
 await browser.close();await vite.close();await new Promise<void>(r=>api.close(()=>r()));await rm(isolated,{recursive:true,force:true})
}
