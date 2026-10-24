// Real provider, real React app, isolated session storage. Cache stays external.
import { chromium } from 'playwright-core'
import { createServer } from 'vite'
import { createApp } from '../backend/src/app'
import { SessionStorage } from '../backend/src/sessionStorage'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
const directory=await mkdtemp(join(tmpdir(),'forextester-live-browser-'))
const api=createApp(undefined,undefined,new SessionStorage({directory}))
await new Promise<void>(r=>api.listen(0,'127.0.0.1',r));const port=(api.address() as {port:number}).port
const vite=await createServer({configFile:false,root:'frontend',cacheDir:join(directory,'vite-cache'),optimizeDeps:{include:['react','react-dom','react-dom/client','lightweight-charts','technicalindicators']},server:{watch:null,hmr:false,host:'127.0.0.1',port:5190,strictPort:true,proxy:{'/api':{target:`http://127.0.0.1:${port}`,changeOrigin:false}}}});await vite.listen()
const browser=await chromium.launch({channel:'chromium',chromiumSandbox:true});const page=await browser.newPage({viewport:{width:1440,height:900}})
const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));const requests:any[]=[]
page.on('response',async r=>{if(new URL(r.url()).pathname==='/api/history'){const body=await r.json().catch(()=>({}));requests.push({url:r.url(),status:r.status(),bid:body.bid?.length,ask:body.ask?.length,error:body.error});console.log(JSON.stringify(requests.at(-1)))}})
try {
 await page.goto('http://127.0.0.1:5190');await page.getByLabel('Backtest name',{exact:true}).fill('EURUSD · January 2024')
 await page.getByLabel('From',{exact:true}).fill('2024-01-09');await page.getByLabel('Through',{exact:true}).fill('2024-01-09')
 assert.equal(requests.length,0)
 await page.getByRole('button',{name:'Load historical data',exact:true}).click()
 await page.waitForFunction(()=>document.querySelector('.data-ready')||document.querySelector('.load-error'),{},{timeout:300000})
 assert.equal(await page.locator('.load-error').count(),0,await page.locator('body').innerText())
 await page.screenshot({path:'docs/task-20/setup-live.png',fullPage:true})
 await page.getByRole('button',{name:'Start backtest',exact:true}).click()
 await page.waitForFunction(()=>document.querySelector('.save-state')?.textContent==='Saved')
 // Capture the initial viewport without applying a manual zoom.
 await page.locator('.chart-canvas').waitFor();await page.waitForTimeout(300)
 await page.screenshot({path:'docs/task-20/trading-live.png',fullPage:true})
 assert.deepEqual(errors,[]);assert.ok(requests.every(r=>r.status===200));assert.ok(requests.some(r=>r.bid>0&&r.ask>0))
 await writeFile('docs/task-20/live-browser-verification.json',JSON.stringify({requests,errors,loaded:await page.getByLabel('Replay progress').innerText(),sandbox:true},null,2))
}finally{await browser.close();await vite.close();await new Promise<void>(r=>api.close(()=>r()));await rm(directory,{recursive:true,force:true})}
