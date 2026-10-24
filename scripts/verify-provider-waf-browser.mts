// Real React loader, default two workers and production backend/provider path.
// Cold external provider cache and isolated durable storage; no automatic retry.
import { chromium } from 'playwright-core'
import { createServer } from 'vite'
import { createApp } from '../backend/src/app'
import { SessionStorage } from '../backend/src/sessionStorage'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const directory=await mkdtemp(join(tmpdir(),'forextester-waf-browser-'))
process.env.FOREXTESTER_CACHE_DIR=join(directory,'cache')
const api=createApp(undefined,undefined,new SessionStorage({directory:join(directory,'sessions')}))
await new Promise<void>(r=>api.listen(0,'127.0.0.1',r))
const port=(api.address() as {port:number}).port
const vite=await createServer({configFile:false,root:'frontend',cacheDir:join(directory,'vite-cache'),optimizeDeps:{include:['react','react-dom','react-dom/client','lightweight-charts','technicalindicators']},server:{watch:null,hmr:false,host:'127.0.0.1',port:5191,strictPort:true,proxy:{'/api':{target:`http://127.0.0.1:${port}`,changeOrigin:false}}}})
await vite.listen()
const browser=await chromium.launch({channel:'chromium',chromiumSandbox:true})
const page=await browser.newPage({viewport:{width:1440,height:900}})
const errors:string[]=[], requests:unknown[]=[], pending:Promise<void>[]=[]
const start=Date.now()
page.on('pageerror',error=>errors.push(error.message))
page.on('response',response=>{
 if(new URL(response.url()).pathname!=='/api/history')return
 const work=(async()=>{
   const body=await response.json().catch(()=>({}))
   const params=new URL(response.url()).searchParams
   const entry={from:params.get('from'),to:params.get('to'),ms:Date.now()-start,status:response.status(),...(response.ok()?{bid:body.bid?.length,ask:body.ask?.length}:{error:body})}
   requests.push(entry);console.log(JSON.stringify(entry))
 })();pending.push(work)
})
try {
 await page.goto('http://127.0.0.1:5191')
 await page.getByLabel('Backtest name',{exact:true}).fill('WAF reliability diagnostic')
 // 30-day pre-roll begins September 17, reproducing failed chunk 1/6 exactly.
 const from=process.env.WAF_FROM??'2026-10-17',through=process.env.WAF_THROUGH??from
 await page.getByLabel('From',{exact:true}).fill(from);await page.getByLabel('Through',{exact:true}).fill(through)
 await page.getByRole('button',{name:'Load historical data',exact:true}).click()
 await page.waitForFunction(()=>document.querySelector('.data-ready')||document.querySelector('.load-error'),{},{timeout:180000})
 await Promise.all(pending)
 const failed=await page.locator('.load-error').count()>0
 const ui=failed?await page.locator('.load-error').innerText():await page.locator('.data-ready').innerText()
 const views=[]
 for(const [width,height] of [[1440,900],[390,844]]){
   await page.setViewportSize({width,height})
   await page.screenshot({path:`docs/task-20/waf-setup-${width}.png`,fullPage:true})
   views.push({width,height,horizontalOverflow:await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth)})
 }
 const evidence={started:new Date(start).toISOString(),ms:Date.now()-start,from,through,freshCache:true,sandbox:true,workers:2,requests,
  outcome:failed?'error':'ready',ui,retryAvailable:failed?await page.getByRole('button',{name:'Retry historical data',exact:true}).isEnabled():false,
  startEnabled:await page.getByRole('button',{name:'Start backtest',exact:true}).isEnabled(),errors,views}
 await writeFile('docs/task-20/waf-browser-verification.json',JSON.stringify(evidence,null,2)+'\n')
 console.log(JSON.stringify({outcome:evidence.outcome,ms:evidence.ms,errors}))
}finally{
 await browser.close();await vite.close();await new Promise<void>(r=>api.close(()=>r()));await rm(directory,{recursive:true,force:true})
}
