import '../backend/src/environment.js'
import assert from 'node:assert/strict'
import {setTimeout as delay} from 'node:timers/promises'
import { mkdtemp,mkdir,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import { createServer } from 'vite'
import { createApp } from '../backend/src/app.js'
import { LocalArchive } from '../backend/src/localArchive.js'
import { SessionStorage } from '../backend/src/sessionStorage.js'
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core')
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH ?? '/home/admin/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome',headless:true,args:['--no-sandbox']})
const output='docs/local-parquet-migration'
await mkdir(output,{recursive:true})
const reports:any[]=[]
try {
 for(const width of [1100,1440]) {
  const directory=await mkdtemp(join(tmpdir(),`forextester-local-browser-${width}-`))
  const storage=new SessionStorage({directory}),archive=new LocalArchive()
  const api=createApp(archive,undefined,storage)
  await new Promise<void>(resolve=>api.listen(0,'127.0.0.1',resolve))
  const apiOrigin=`http://127.0.0.1:${(api.address() as {port:number}).port}`
  const vite=await createServer({configFile:false,root:resolve('frontend'),server:{host:'127.0.0.1',port:0,proxy:{'/api':{target:apiOrigin,changeOrigin:false}}}})
  await vite.listen()
  const origin=`http://127.0.0.1:${(vite.httpServer!.address() as {port:number}).port}`
  const context=await browser.newContext({viewport:{width,height:width===1100?800:1000}})
  const page=await context.newPage(),external:string[]=[],requests:string[]=[],errors:string[]=[]
  page.on('request',r=>{requests.push(r.url());if(!r.url().startsWith(origin)&&!r.url().startsWith('data:'))external.push(r.url())})
  page.on('pageerror',e=>errors.push(e.message))
  page.on('dialog',async d=>await d.accept())
  const saved=async(predicate:(record:any)=>boolean=()=>true)=>{
   for(let attempt=0;attempt<400;attempt++) {
    if(await page.locator('.save-state').textContent()==='Saved') {
     const record=(await storage.list()).sessions[0],clock=await page.locator('.replay-clock').textContent()
     if(record && clock===new Date(record.checkpoint.replay.timestamp!).toISOString().slice(0,16).replace('T',' ')+' UTC' && predicate(record))return record
    }
    await delay(25)
   }
   throw Error('The durable checkpoint did not match the displayed replay state')
  }
  try {
   await page.goto(origin)
   await page.getByRole('button',{name:'Start backtest',exact:true}).waitFor()
   await page.waitForFunction(()=>!(document.querySelector('#setup-form')?.closest('fieldset') as HTMLFieldSetElement)?.disabled)
   await page.waitForFunction(()=>!document.querySelector<HTMLButtonElement>('.setup-footer .primary-action')?.disabled)
   assert.equal(await page.getByRole('button',{name:'90 days',exact:true}).isDisabled(),false)
   assert(!/Databento|6E|paid|credit|rollover/i.test(await page.locator('.setup-workspace').innerText()))
   await page.getByLabel('Browse cached archive').selectOption('2005-06')
   assert((await page.locator('.timeline-scale').innerText()).includes('2005'))
   await page.locator('.setup-advanced summary').click()
   await page.getByLabel('From',{exact:true}).fill('2005-06-01')
   await page.getByLabel('Through',{exact:true}).fill('2005-06-07')
   await page.getByLabel('Backtest name',{exact:true}).fill(`Local archive ${width}`)
   await page.getByLabel('Round-trip commission (USD per standard lot)',{exact:true}).fill('7')
   await page.getByRole('button',{name:'Start backtest',exact:true}).waitFor({state:'visible'})
   assert.equal(await page.getByRole('button',{name:'Start backtest',exact:true}).isDisabled(),false)
   await page.locator('.setup-form').evaluate((form: HTMLElement)=>{form.scrollTop=0})
   await page.screenshot({path:`${output}/setup-${width}.png`,fullPage:true})
   await page.getByRole('button',{name:'Start backtest',exact:true}).click()
   await page.locator('.phase-trading').waitFor({timeout:30000})
   let record=await saved()
   assert.equal(record.symbol,'EURUSD')
   assert.equal(record.checkpoint.trading.executionModel,'single-price-m1-v1')
   assert.equal(await page.getByLabel('Replay status').innerText(),'Paused')
   assert.equal(await page.locator('.pane-toolbar .bid-label').first().textContent(),'Mid')
   const quote=record.checkpoint.trading.quote!
   assert('priceModel' in quote && quote.trade)
   const stop=quote.trade.close-.01
   for(let i=0;i<2;i++) {
    await page.getByRole('button',{name:'Buy',exact:true}).click()
    await page.getByLabel('Enter price with keyboard').click()
    await page.getByLabel('SL price',{exact:true}).fill(stop.toFixed(7))
    await page.getByRole('button',{name:'Confirm order',exact:true}).click()
   }
   await page.getByRole('button',{name:'Next Min',exact:true}).click()
   record=await saved(r=>r.checkpoint.trading.positions.length===2);assert.equal(record.checkpoint.trading.positions.length,2)
   const pnlBefore=record.checkpoint.trading
   assert(pnlBefore.positions.every(p=>p.entryCommissionUsd>0 && p.lots>0))
   await page.screenshot({path:`${output}/trading-${width}.png`,fullPage:true})
   const firstId=record.checkpoint.trading.positions[0].id
   await page.getByRole('button',{name:`Close ${firstId}`,exact:true}).click()
   await page.getByRole('button',{name:'Next Min',exact:true}).click()
   record=await saved(r=>r.checkpoint.trading.closed.length===1);assert.equal(record.checkpoint.trading.closed.length,1);assert.equal(record.checkpoint.trading.positions.length,1)
   const beforeFinish=record.checkpoint
   await page.getByRole('button',{name:'Finish backtest',exact:true}).click()
   await page.locator('.phase-finished').waitFor();record=await saved(r=>r.checkpoint.lifecycle==='finished')
   assert.equal(record.checkpoint.replay.timestamp,beforeFinish.replay.timestamp)
   assert.deepEqual(record.checkpoint.trading,beforeFinish.trading)
   assert(await page.locator('.results-account-chart h3').isVisible())
   assert(!/Databento|6E/.test(await page.locator('.results-workspace').innerText()))
   await page.screenshot({path:`${output}/results-${width}.png`,fullPage:true})
   await page.getByRole('button',{name:'Resume Backtest',exact:true}).click()
   await page.locator('.phase-trading').waitFor();record=await saved(r=>r.checkpoint.lifecycle==='trading')
   assert.equal(record.checkpoint.replay.timestamp,beforeFinish.replay.timestamp)
   await page.reload();await page.getByRole('button',{name:'Resume backtest',exact:true}).click()
   await page.locator('.phase-trading').waitFor();record=await saved(r=>r.checkpoint.lifecycle==='trading')
   assert.deepEqual(record.checkpoint.trading,beforeFinish.trading)
   assert.equal(record.checkpoint.replay.timestamp,beforeFinish.replay.timestamp)
   assert.equal(await page.getByLabel('Replay status').innerText(),'Paused')
   const beforeKeyboard=record.checkpoint.replay.timestamp!
   await page.locator('.chart-canvas').first().click({position:{x:150,y:150}})
   await page.keyboard.press('Shift+ArrowRight');record=await saved(r=>r.checkpoint.replay.timestamp>beforeKeyboard)
   assert(record.checkpoint.replay.timestamp!>beforeKeyboard)
   const durableTimestamp=record.checkpoint.replay.timestamp
   await page.keyboard.press('Shift+ArrowLeft')
   await page.getByRole('button',{name:'Return to current replay'}).waitFor()
   assert.equal((await saved()).checkpoint.replay.timestamp,durableTimestamp)
   await page.getByRole('button',{name:'Return to current replay'}).click()
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth)
   assert.equal(overflow,false)
   assert.deepEqual(external,[]);assert.deepEqual(errors,[])
   assert(!requests.some(url=>/hist\.databento|\/history\/(download|estimate)/.test(url)))
   reports.push({width,height:width===1100?800:1000,range:record.range,symbol:record.symbol,sessionId:record.id,closedPositions:record.checkpoint.trading.closed.length,remainingPositions:record.checkpoint.trading.positions.length,restoredReplayTimestamp:beforeFinish.replay.timestamp,keyboardAdvancedTo:durableTimestamp,historyRequests:requests.filter(u=>u.includes('/api/history?')).length,externalRequests:external,pageErrors:errors,horizontalOverflow:overflow,sessionDirectory:directory})
  } catch(error) {await page.screenshot({path:`${output}/failure-${width}.png`,fullPage:true});console.error(await page.locator('body').innerText());throw error}
  finally {await context.close();await vite.close();await new Promise<void>(resolve=>{api.close(()=>resolve());api.closeAllConnections()});await storage.close()}
 }
 await writeFile(`${output}/browser-verification.json`,JSON.stringify(reports,null,2)+'\n')
 console.log(JSON.stringify(reports,null,2))
} finally {await browser.close()}
