import { chromium } from 'playwright-core'
import { createServer } from 'vite'
import { createApp } from '../backend/src/app'
import { SessionStorage } from '../backend/src/sessionStorage'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
const directory=await mkdtemp(join(tmpdir(),'forextester-browser-task20-'))
const start=Date.UTC(2024,0,9)
const bid=Array.from({length:1800},(_,i)=>{const n=i-1440;const open=n<0?1.1+Math.sin(i/20)*.0005:1.1002;return {timestamp:start+n*60000,open,close:open+.0001,high:n===-30?1.102:n<0?open+.00015:1.1008,low:n===-20?1.098:n<0?open-.00008:n===5?1.099:1.1000,volume:1}})
let historyRequests=0
const api=createApp(async config=>{historyRequests++;const offset=config.priceType==='ask'?.0002:0;return bid.filter(b=>b.timestamp>=+config.dates.from&&b.timestamp<+config.dates.to).map(b=>({...b,open:b.open+offset,high:b.high+offset,low:b.low+offset,close:b.close+offset}))},undefined,new SessionStorage({ directory }))
await new Promise<void>(r=>api.listen(0,'127.0.0.1',r));const port=(api.address() as {port:number}).port
const vite=await createServer({configFile:false,root:'frontend',cacheDir:join(directory,'vite-cache'),optimizeDeps:{include:['react','react-dom','react-dom/client','lightweight-charts','technicalindicators']},server:{watch:null,hmr:false,host:'127.0.0.1',port:5189,strictPort:true,proxy:{'/api':{target:`http://127.0.0.1:${port}`,changeOrigin:false}}}});await vite.listen()
const browser=await chromium.launch({channel:'chromium',chromiumSandbox:true})
const errors:string[]=[];const measurements:any[]=[]
const p=await browser.newPage({viewport:{width:1440,height:900}});p.on('pageerror',e=>errors.push(e.message))
p.on('dialog',d=>d.accept());await p.addInitScript('globalThis.__name = (target) => target; globalThis.__forexReplayPerformance = { samples: {}, counts: {} }')
const button=(name:string)=>p.getByRole('button',{name,exact:true})
const shot=async(name:string)=>p.screenshot({path:`docs/task-20/${name}.png`,fullPage:true})
const saved=async()=>{await p.waitForFunction(()=>document.querySelector('.save-state')?.textContent==='Saved')}
async function selectStop(fraction:number) {
  await p.waitForTimeout(550)
  const box=await p.locator('.chart-canvas').first().boundingBox();assert.ok(box)
  await p.mouse.move(box.x+box.width*.6,box.y+box.height*fraction)
  await p.mouse.click(box.x+box.width*.6,box.y+box.height*fraction)
  const text=await p.getByRole('region',{name:'Place stop-loss'}).innerText(); console.log(text)
  assert.ok(text.includes('SL '));return text
}
try {
 await p.goto('http://127.0.0.1:5189');await button('Load historical data').waitFor();await p.waitForFunction(()=>!document.querySelector<HTMLFieldSetElement>('.workspace-controls')?.disabled)
 assert.equal(historyRequests,0)
 await p.getByLabel('Backtest name',{exact:true}).fill('London session review')
 await p.getByLabel('Starting balance (USD)',{exact:true}).fill('10000')
 await p.getByLabel('Round-trip commission (USD per standard lot)',{exact:true}).fill('7')
 for(const [width,height] of [[1440,900],[1728,864],[390,844]]) {await p.setViewportSize({width,height});await shot(`setup-${width}`);assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth),width);assert.ok(await p.locator('.setup-workspace').evaluate(e=>e.scrollWidth<=e.clientWidth))}
 await p.setViewportSize({width:1440,height:900});await button('Load historical data').click();await button('Start backtest').waitFor();await p.waitForFunction(()=>document.querySelector('.data-ready'))
 await button('Start backtest').click();await p.locator('.chart-canvas').waitFor();await p.waitForTimeout(300)
 assert.equal(await p.getByLabel('Starting balance (USD)',{exact:true}).count(),0);assert.equal(await p.locator('.trading-journal').count(),0)
 await p.locator('input[name="chart-count"][value="3"]').check();await p.waitForTimeout(200)
 let boxSync=await p.locator('.chart-canvas').first().boundingBox();assert.ok(boxSync)
 await p.mouse.move(boxSync.x+boxSync.width*.7,boxSync.y+boxSync.height*.4);await p.waitForTimeout(100)
 assert.ok(await p.evaluate(()=>globalThis.__forexReplayPerformance!.counts['sync.crosshair.set']>0),'crosshair synchronized')
 const rangesBefore=await p.evaluate(()=>globalThis.__forexReplayPerformance!.counts['sync.setRange']||0)
 await p.mouse.wheel(0,-100);await p.waitForTimeout(200)
 assert.ok(await p.evaluate(()=>globalThis.__forexReplayPerformance!.counts['sync.setRange'])>rangesBefore,'viewport synchronized')
 await p.mouse.wheel(0,100);await p.waitForTimeout(200)
 await button('Buy').click();await p.waitForTimeout(550)
 const oscillator=await p.locator('.chart-canvas').nth(1).boundingBox();assert.ok(oscillator)
 await p.mouse.click(oscillator.x+oscillator.width*.6,oscillator.y+oscillator.height*.8)
 assert.ok(await button('Confirm order').isDisabled(),'oscillator click ignored');assert.ok((await p.locator('.stop-placement').innerText()).includes('Click the price chart'))
 await button('Cancel placement').click();await p.locator('input[name="chart-count"][value="1"]').check()
 for(const timeframe of ['M5','M15','H1','H4','M1']) {
   await p.getByLabel('Chart 1 timeframe',{exact:true}).selectOption(timeframe);await button('Buy').click();await selectStop(.25);await button('Cancel placement').click()
 }

 await button('Buy').click();await selectStop(.70);assert.equal(await p.locator('[data-order-id]').count(),0);await button('Confirm order').click();assert.equal(await p.locator('[data-order-id]').count(),1)
 await button('Next Candle').click();assert.equal(await p.locator('[data-position-id]').count(),1)
 const firstId=await p.locator('[data-position-id]').first().getAttribute('data-position-id')
 await p.getByLabel('Setup assignment').selectOption({index:1});await button('Buy').click();await selectStop(.85);await button('Confirm order').click();await button('Next Candle').click();assert.equal(await p.locator('[data-position-id]').count(),2)
 await button('Modify SL '+firstId).click();await selectStop(.65);await button('Confirm SL change').click()
 for(const [width,height] of [[1440,900],[1728,864],[390,844]]) {
   await p.setViewportSize({width,height});await p.waitForTimeout(200);await shot(`trading-${width}`)
   await p.waitForTimeout(550)
  const box=await p.locator('.chart-canvas').first().boundingBox();const price=await p.locator('.chart-canvas').first().locator('canvas').evaluateAll(nodes=>nodes.map(n=>{const b=n.getBoundingClientRect();return {width:b.width,height:b.height}}).filter(b=>b.width>100).sort((a,b)=>b.height-a.height)[0]);measurements.push({width,height,chart:box,heightRatio:box!.height/height,price,priceHeightRatio:price.height/height})
   assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth),width)
 }
 await p.setViewportSize({width:1440,height:900})
 for(const count of [2,3,1]) {await p.locator(`input[name="chart-count"][value="${count}"]`).check();await p.waitForTimeout(100);assert.equal(await p.locator('.tv-lightweight-charts').count(),count);if(count>1)await shot(`trading-${count}-charts`)}
 await button('Next Candle').click();await button('Next Candle').click();await button('Next Candle').click()
 assert.equal(await p.locator('[data-position-id]').count(),1,'one automatic stop should execute')
 const remaining=await p.locator('[data-position-id]').getAttribute('data-position-id');await button('Close '+remaining).click();await button('Next Candle').click();assert.equal(await p.locator('[data-position-id]').count(),0)
 await p.getByLabel('Setup assignment').selectOption('');await button('Sell').click();await selectStop(.25);await button('Confirm order').click();await button('Next Candle').click();assert.equal(await p.locator('[data-position-id]').count(),1)
 const sellId=await p.locator('[data-position-id]').getAttribute('data-position-id');await button('Close '+sellId).click();await button('Next Candle').click()
 await saved();await button('Finish backtest').click();await p.getByLabel('Backtest results',{exact:true}).waitFor();await saved()
 for(const [width,height] of [[1440,900],[1728,864],[390,844]]) {await p.setViewportSize({width,height});await shot(`results-${width}`);assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth),width)}
 assert.ok(await p.locator('.trading-journal').count());await button('Journal').click();await p.getByRole('button',{name:/Details for setup/}).first().click();await p.getByLabel(/Setup notes/).fill('Two independent stops reviewed in Chromium.');await saved();const downloads=p.waitForEvent('download');await p.getByRole('button',{name:/CSV/}).click();const download=await downloads;await download.saveAs('docs/task-20/browser-journal.csv');await writeFile('docs/task-20/browser-journal.csv',(await readFile('docs/task-20/browser-journal.csv','utf8')).replaceAll('\r\n','\n')) // Normalize only evidence line endings for Git.
 await button('Equity & drawdown').click();await shot('results-equity');await button('Overview').click();const requests=historyRequests;await p.reload();await button('Resume session').click();await p.getByLabel('Backtest results',{exact:true}).waitFor();assert.equal(historyRequests,requests)
 assert.deepEqual(errors,[])
 await writeFile('docs/task-20/browser-verification.json',JSON.stringify({measurements,historyRequests,errors,verified:['setup','no automatic download','two independent chart stops','modify stop','automatic stop','manual close','sell','finish','CSV','finished restore without download','1/2/3 charts','crosshair and viewport synchronization','oscillator click ignored','SL selection on every timeframe','responsive']},null,2))
 console.log(JSON.stringify({measurements,errors}))
} catch(e) {await shot('failure');throw e} finally {await browser.close();await vite.close();await new Promise<void>(r=>api.close(()=>r()));await rm(directory,{recursive:true,force:true})}
