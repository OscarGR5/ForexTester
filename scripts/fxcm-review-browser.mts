// One new maximum-range attempt, preserving all original failed evidence.
import { chromium } from 'playwright-core'
import { createServer } from 'vite'
import { createApp } from '../backend/src/app'
import { SessionStorage } from '../backend/src/sessionStorage'
import { historyFingerprint } from '../frontend/src/sessionCodec'
import { mkdtemp, rm, writeFile, stat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
const temporary=await mkdtemp(join(tmpdir(),'fxcm-review-browser-'))
process.env.FOREXTESTER_CACHE_DIR=join(temporary,'cache');process.env.FOREXTESTER_DATA_DIR=join(temporary,'data')
const storage=new SessionStorage({directory:process.env.FOREXTESTER_DATA_DIR}),api=createApp(undefined,undefined,storage)
await new Promise<void>(r=>api.listen(0,'127.0.0.1',r));const apiPort=(api.address() as {port:number}).port
const vite=await createServer({configFile:false,root:'frontend',cacheDir:join(temporary,'vite'),optimizeDeps:{include:['react','react-dom','react-dom/client','lightweight-charts','technicalindicators']},server:{watch:null,hmr:false,host:'127.0.0.1',port:5195,strictPort:true,proxy:{'/api':{target:`http://127.0.0.1:${apiPort}`,changeOrigin:false}}}});await vite.listen()
const browser=await chromium.launch({channel:'chromium',chromiumSandbox:true}),page=await browser.newPage({viewport:{width:1440,height:900}})
await page.addInitScript('globalThis.__name = (target) => target')
const errors:string[]=[],requests:any[]=[],storageTransfers:any[]=[],pending:Promise<void>[]=[]
const metrics:any={selectedFrom:'2024-07-01',selectedThroughInclusive:'2024-09-28',apiToExclusive:'2024-09-29',expectedPrerollFrom:'2024-06-01'}
page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept())
page.on('response',response=>{
 const url=new URL(response.url()),request=response.request()
 if(url.pathname==='/api/history')pending.push((async()=>{const body=await response.json().catch(()=>({}));const record={from:url.searchParams.get('from'),to:url.searchParams.get('to'),status:response.status(),bid:body.bid?.length,ask:body.ask?.length,code:body.code,error:body.error};requests.push(record);console.log(JSON.stringify(record))})())
 if(url.pathname.startsWith('/api/storage')&&request.method()!=='GET')pending.push((async()=>{await response.finished();storageTransfers.push({method:request.method(),path:url.pathname.replace(/[a-f0-9]{64}/g,'<history-id>').replace(/[a-f0-9-]{36}/g,'<session-id>'),status:response.status(),requestBytes:request.postDataBuffer()?.byteLength??0,requestMs:request.timing().responseEnd})})())
})
const button=(name:string)=>page.getByRole('button',{name,exact:true})
const saved=()=>page.waitForFunction(()=>document.querySelector('.save-state')?.textContent==='Saved',{},{timeout:120000})
const record=async()=>{await saved();const rows=(await storage.list()).sessions;assert.equal(rows.length,1);return rows[0]}
let failure:string|null=null
try{
 await page.goto('http://127.0.0.1:5195');await page.waitForFunction(()=>!document.querySelector<HTMLFieldSetElement>('.workspace-controls')?.disabled)
 await page.getByLabel('Historical data provider').selectOption('fxcm');await page.waitForFunction(()=>document.querySelector('.coverage-summary'))
 await page.getByLabel('Backtest name',{exact:true}).fill('FXCM full 90-day review')
 await page.getByLabel('From',{exact:true}).fill(metrics.selectedFrom);await page.getByLabel('Through',{exact:true}).fill(metrics.selectedThroughInclusive)
 const start=performance.now();await button('Load historical data').click()
 await page.waitForFunction(()=>document.querySelector('.data-ready')||document.querySelector('.load-error'),{},{timeout:300000})
 metrics.loadMs=Math.round(performance.now()-start)
 if(await page.locator('.load-error').count()){
  failure=await page.locator('.load-error').innerText();metrics.incompleteDatasetRejected=await button('Start backtest').isDisabled();assert.equal((await storage.list()).sessions.length,0)
  await page.screenshot({path:'docs/fxcm/review/full-range-failure.png',fullPage:true})
 }else{
  const saveStart=performance.now(),setup=await record();metrics.afterReadyToSavedMs=Math.round(performance.now()-saveStart);metrics.clickToSavedMs=Math.round(performance.now()-start)
  const readStart=performance.now(),history=await storage.getHistory(setup.historyId);metrics.verifiedDiskReadMs=Math.round(performance.now()-readStart)
  assert.equal(history.from,metrics.expectedPrerollFrom);assert.equal(history.to,metrics.apiToExclusive);assert.equal(history.tradingFrom,metrics.selectedFrom);assert.equal(history.bid.length,history.ask.length);assert.equal(history.provenance?.provider,'fxcm');assert.equal(await historyFingerprint(history),setup.historyId)
  Object.assign(metrics,{bid:history.bid.length,ask:history.ask.length,tradingCandles:history.bid.filter(b=>b.timestamp>=Date.parse(history.tradingFrom)).length,archives:history.provenance.sources?.length,historyId:setup.historyId,compressedHistoryBytes:(await stat(join(process.env.FOREXTESTER_DATA_DIR!,'history',`${setup.historyId}.json.gz`))).size})
  await page.screenshot({path:'docs/fxcm/review/full-range-setup.png',fullPage:true})
  await button('Start backtest').click();await page.locator('.chart-canvas canvas').first().waitFor();await saved();await button('Next Candle').click();await saved()
  await button('Finish backtest').click();await page.getByRole('heading',{name:/Backtest results/}).waitFor();await saved()
  const finished=await record(),checkpoint=JSON.stringify(finished.checkpoint),historyCount=requests.length
  const restoreStart=performance.now();await page.reload();await button('Resume session').click();await page.getByRole('heading',{name:/Backtest results/}).waitFor();await saved();metrics.refreshRestoreMs=Math.round(performance.now()-restoreStart)
  assert.equal((await record()).historyId,setup.historyId);assert.equal(JSON.stringify((await record()).checkpoint),checkpoint);assert.equal(requests.length,historyCount);metrics.restoreWithoutHistoryDownloads=true
  await storage.close();const restarted=new SessionStorage({directory:process.env.FOREXTESTER_DATA_DIR})
  try{const restartStart=performance.now();assert.equal((await restarted.getHistory(setup.historyId)).bid.length,history.bid.length);assert.equal((await restarted.restore(setup.id)).record.historyId,setup.historyId);metrics.storageRestartRestoreMs=Math.round(performance.now()-restartStart);metrics.storageRestartVerified=true}finally{await restarted.close()}
  metrics.cachedArchiveFiles=(await readdir(join(process.env.FOREXTESTER_CACHE_DIR!,'fxcm'))).length
  assert.deepEqual(errors,[]);assert.equal(requests.length,18);assert.ok(requests.every(r=>r.status===200));metrics.verified=true
 }
}catch(error){failure=error instanceof Error?error.message:String(error);console.error(failure);process.exitCode=1}
finally{
 await Promise.allSettled(pending)
 await writeFile('docs/fxcm/review/full-range-browser.json',JSON.stringify({checkedAt:new Date().toISOString(),sandbox:true,freshIsolatedCacheAndStorage:true,validationChanged:false,metrics,requests,storageTransfers,errors,failure},null,2))
 console.log(JSON.stringify({metrics,failure}))
 await browser.close();await vite.close();await new Promise<void>(r=>api.close(()=>r()));await rm(temporary,{recursive:true,force:true})
}
