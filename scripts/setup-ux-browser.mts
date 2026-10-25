import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { createApp } from '../backend/src/app.js'
import { HistoryService } from '../backend/src/history.js'
import { DatabentoClient } from '../backend/src/databento.js'
import { SessionStorage } from '../backend/src/sessionStorage.js'
import { cacheDirectory } from '../backend/src/projectPaths.js'
import { automaticReplayStart, cachedPreset } from '../frontend/src/cacheCalendar.js'
import { aggregateBidCandles, TIMEFRAMES, VISIBLE_TIMEFRAMES } from '../frontend/src/history.js'
import { calculateIndicators, indicatorPreset } from '../frontend/src/indicators.js'
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core')
const directory=await mkdtemp(join(tmpdir(),'forextester-setup-ux-'))
await mkdir('docs/setup-ux',{recursive:true})
const evidence:any={isolatedSessions:directory,credentialsConfigured:false,providerRequests:0,paidSubmissions:0,screenshots:[],errors:[],checks:{},indicators:[]}
class OfflineClient extends DatabentoClient {
 constructor(){super('')}
 override async availability():Promise<never>{evidence.providerRequests++;throw Error('Provider request forbidden')}
 override async contracts():Promise<never>{evidence.providerRequests++;throw Error('Provider request forbidden')}
 override async cost():Promise<never>{evidence.providerRequests++;throw Error('Provider request forbidden')}
 override async download():Promise<never>{evidence.providerRequests++;throw Error('Provider request forbidden')}
}
const cache=join(cacheDirectory(),'databento')
async function manifest(){const names=(await readdir(cache)).sort();return Promise.all(names.map(async name=>[name,createHash('sha256').update(await readFile(join(cache,name))).digest('hex')]))}
const before=await manifest()
const service=new HistoryService(new OfflineClient(),cache,{DATABENTO_TEST_BUDGET_USD:'0'})
const calendar=await service.calendar(),range=cachedPreset(calendar,90)!
assert.deepEqual(range,{from:'2024-01-01',to:'2024-03-31'})
const history=await service.readCached('2023-12-02','2024-03-31'),eligible=automaticReplayStart(history.candles,range)!
evidence.selected={from:range.from,through:'2024-03-30'};evidence.replay={...eligible,utc:new Date(eligible.timestamp).toISOString()}
const visible=history.candles.slice(0,eligible.index+1)
let first=eligible.index;while(first>0&&history.candles[first-1].instrumentId===history.candles[eligible.index].instrumentId)first--
for(const timeframe of TIMEFRAMES){const candles=aggregateBidCandles(visible.slice(first),timeframe).map(({timestamp,...bar})=>({...bar,time:timestamp/1000 as any}));const settings=indicatorPreset(timeframe),output=calculateIndicators(candles,settings,timeframe)
 const ready=(!settings.ichimoku.enabled||!!output.cloud.length)&&(!settings.bollinger.enabled||!!output.upper.length)&&(!settings.stochastic.enabled||!!output.d.length)
 if(timeframe!=='D1')assert.ok(ready);evidence.indicators.push({timeframe,candles:candles.length,ready,cloud:output.cloud.length,bollinger:output.upper.length,stochastic:output.d.length})}
const storage=new SessionStorage({directory:join(directory,'sessions')}),backend=createApp(service,()=>new Date(),storage)
await new Promise<void>(resolve=>backend.listen(5197,'127.0.0.1',resolve))
const vite=await createServer({configFile:false,root:'frontend',cacheDir:join(directory,'vite'),server:{watch:null,hmr:false,host:'127.0.0.1',port:5196,strictPort:true,proxy:{'/api':{target:'http://127.0.0.1:5197',changeOrigin:false}}}})
await vite.listen()
const browser=await chromium.launch({channel:'chromium',chromiumSandbox:true})
const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage()
await page.addInitScript('globalThis.__name = target => target')
page.on('pageerror',error=>evidence.errors.push(error.message))
page.on('request',request=>{if(new URL(request.url()).pathname==='/api/history/download')evidence.paidSubmissions++})
const button=(name:string)=>page.getByRole('button',{name,exact:true})
const saved=()=>page.waitForFunction(()=>document.querySelector('.save-state')?.textContent==='Saved')
async function screenshot(name:string){const path=`docs/setup-ux/${name}.png`;await page.screenshot({path,fullPage:true});evidence.screenshots.push(path)}
try {
 await page.goto('http://127.0.0.1:5196');await page.getByText('90 days selected — already downloaded.',{exact:true}).waitFor()
 await button('90 days').click()
 for(const [width,height] of [[1440,1000],[1100,800]]){await page.setViewportSize({width,height});await screenshot(`setup-${width}`);assert.ok(await button('Start backtest').isVisible());const primary=await button('Start backtest').boundingBox();assert.ok(primary && primary.y+primary.height<=height);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width)}
 await page.setViewportSize({width:1440,height:1000})
 const end=page.getByRole('slider',{name:'Historical end date'})
 await end.focus();await end.press('ArrowLeft');assert.equal(await end.getAttribute('aria-valuetext'),'29 Mar 2024');await end.press('ArrowRight')
 evidence.checks.keyboard=true
 const start=page.getByRole('slider',{name:'Historical start date'}),box=(await start.boundingBox())!
 // Drag a native handle through Chromium's actual mouse input.
 const x=box.x+12+(box.width-24)*30/119,y=box.y+box.height/2
 await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+(box.width-24)*2/119,y,{steps:6});await page.mouse.up()
 assert.notEqual(await start.getAttribute('aria-valuetext'),'1 Jan 2024');await button('90 days').click();evidence.checks.mouse=true
 const t0=performance.now();await button('Start backtest').click();await page.locator('.chart-canvas').first().waitFor();await saved();evidence.startDurationMs=performance.now()-t0
 assert.equal(await page.getByLabel('Replay status',{exact:true}).innerText(),'Paused')
 assert.equal(await page.locator('dialog').count(),0)
 for(const [width,height] of [[1440,1000],[1100,800]]){await page.setViewportSize({width,height});await screenshot(`trading-${width}`);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width)}
 await page.setViewportSize({width:1440,height:1000})
 let records=(await storage.list()).sessions;assert.equal(records.length,1)
 const record=records[0];assert.equal(record.checkpoint.replay.startTimestamp,eligible.timestamp);assert.equal(record.checkpoint.replay.startIndex,eligible.index)
 assert.equal(record.checkpoint.replay.index,eligible.index);evidence.checks.oneClick=true
 for(const timeframe of VISIBLE_TIMEFRAMES){await page.getByLabel('Chart 1 timeframe',{exact:true}).selectOption(timeframe);await page.waitForTimeout(100);assert.ok(await page.locator('.chart-canvas canvas').count()>0)}
 await page.getByLabel('Chart 1 timeframe',{exact:true}).selectOption('H4');await page.waitForTimeout(150)
 await page.locator('.chart-canvas').first().hover();for(let i=0;i<15;i++)await page.mouse.wheel(0,1000);await page.waitForTimeout(250);await screenshot('trading-h4-history-1440')
 assert.match(await page.locator('.indicator-readiness').innerText(),/Indicators ready/);evidence.checks.visibleIndicatorReadiness=true
 await saved();const checkpoint=(await storage.list()).sessions[0].checkpoint
 await page.reload();await button('Resume backtest').click();await page.locator('.chart-canvas').first().waitFor();await saved()
 records=(await storage.list()).sessions
 assert.equal(records[0].checkpoint.replay.startTimestamp,checkpoint.replay.startTimestamp);assert.equal(records[0].checkpoint.replay.startIndex,checkpoint.replay.startIndex);assert.equal(records[0].checkpoint.replay.index,checkpoint.replay.index)
 evidence.checks.restoreUnchanged=true
 assert.deepEqual(await manifest(),before);evidence.checks.originalCacheUnchanged=true
 assert.equal(evidence.providerRequests,0);assert.equal(evidence.paidSubmissions,0);assert.deepEqual(evidence.errors,[])
 await writeFile('docs/setup-ux/browser-evidence.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2))
} finally {await browser.close();await vite.close();await new Promise<void>(resolve=>{backend.close(()=>resolve());backend.closeAllConnections()})}
