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
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core')
const directory = await mkdtemp(join(tmpdir(), 'forextester-chart-ux-'))
const output = 'docs/topbar-tightening'
await mkdir(output, { recursive: true })
const evidence: any = { isolatedSessions: directory, providerRequests: 0, paidSubmissions: 0, screenshots: [], errors: [], checks: {} }
class OfflineClient extends DatabentoClient {
 constructor() { super('') }
 override async availability(): Promise<never> { evidence.providerRequests++; throw Error('Provider request forbidden') }
 override async contracts(): Promise<never> { evidence.providerRequests++; throw Error('Provider request forbidden') }
 override async cost(): Promise<never> { evidence.providerRequests++; throw Error('Provider request forbidden') }
 override async download(): Promise<never> { evidence.providerRequests++; throw Error('Provider request forbidden') }
}
const cache = join(cacheDirectory(), 'databento')
async function manifest() { return Promise.all((await readdir(cache)).sort().map(async name => [name, createHash('sha256').update(await readFile(join(cache, name))).digest('hex')])) }
const before = await manifest()
let storage = new SessionStorage({ directory: join(directory, 'sessions') })
let backend = createApp(new HistoryService(new OfflineClient(), cache, { DATABENTO_TEST_BUDGET_USD: '0' }), () => new Date(), storage)
await new Promise<void>(resolve => backend.listen(5199, '127.0.0.1', resolve))
// Observe public chart APIs; all navigation and trading below use browser input.
const vite = await createServer({ configFile: false, root: 'frontend', cacheDir: join(directory, 'vite'),
 plugins: [{ name: 'chart-observation', transform(code, id) {
  if (!id.endsWith('/ChartPane.tsx')) return
  return code.replace('stopLines.current = new StopLines(series)', `globalThis.__uxCharts ??= {}; const record = { chart, series, lines: new Set() }; globalThis.__uxCharts[id] = record; const create = series.createPriceLine.bind(series), remove = series.removePriceLine.bind(series); series.createPriceLine = options => { const line = create(options); record.lines.add(line); return line; }; series.removePriceLine = line => { record.lines.delete(line); remove(line); }; stopLines.current = new StopLines(series)`)
 } }], server: { watch: null, hmr: false, host: '127.0.0.1', port: 5198, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:5199', changeOrigin: false } } } })
await vite.listen()
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? '/home/admin/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell' })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await context.newPage()
await page.addInitScript('globalThis.__name = target => target')
page.on('dialog', dialog => dialog.accept())
page.on('pageerror', error => evidence.errors.push(error.message))
page.on('request', request => { if (new URL(request.url()).pathname === '/api/history/download') evidence.paidSubmissions++ })
const button = (name: string) => page.getByRole('button', { name, exact: true })
const settle = () => page.waitForTimeout(250)
const saved = () => page.waitForFunction(() => document.querySelector('.save-state')?.textContent === 'Saved')
const record = async () => { await saved(); return (await storage.list()).sessions[0] }
async function screenshot(name: string) { const path = `${output}/${name}.png`; await page.screenshot({ path, fullPage: true }); evidence.screenshots.push(path) }
const ranges = () => page.evaluate(() => Object.fromEntries(Object.entries((globalThis as any).__uxCharts).filter(([id]) => Number(id) < document.querySelectorAll('.chart-pane').length).map(([id, v]: any) => [id, v.chart.timeScale().getVisibleLogicalRange()])))
const entryLines = () => page.evaluate(() => Object.entries((globalThis as any).__uxCharts).filter(([id]) => Number(id) < document.querySelectorAll('.chart-pane').length).map(([,v]: any) => [...v.lines].map((line: any) => line.options()).filter((o: any) => /\b[BS][12]\b/.test(o.title))))
async function pan(id: number, from: number, to: number) {
 const box = (await page.locator('.chart-canvas').nth(id).boundingBox())!
 await page.mouse.move(box.x + box.width * from, box.y + 100); await page.mouse.down()
 await page.mouse.move(box.x + box.width * to, box.y + 100, { steps: 20 }); await page.mouse.up(); await settle()
}
async function selectStop(price: number) {
 const box = (await page.locator('.chart-canvas').first().boundingBox())!
 const y = await page.evaluate(price => (globalThis as any).__uxCharts[0].series.priceToCoordinate(price), price)
 assert.ok(y > 0 && y < box.height, `Stop outside pane: ${y}/${box.height}`)
 await page.mouse.move(box.x + 80, box.y + y); await page.mouse.click(box.x + 80, box.y + y); await settle()
}
async function annotationFits() {
 const annotation = await page.locator('.draft-stop-annotation').first().boundingBox(), tick = await button('Confirm draft stop-loss').first().boundingBox(), plot = await page.locator('.chart-canvas').first().boundingBox()
 assert.ok(annotation && tick && plot)
 assert.ok(tick.x >= plot.x && annotation.x + annotation.width <= plot.x + plot.width && tick.y >= plot.y && tick.y + tick.height <= plot.y + plot.height)
 assert.ok(tick.x + tick.width <= (await page.locator('.draft-stop-annotation > span').first().boundingBox())!.x)
 return { annotation, tick, plot }
}
async function restore() {
 await page.reload(); await button('Resume backtest').click(); await page.locator('.chart-canvas').first().waitFor(); await settle(); await saved()
}
try {
 await page.goto('http://127.0.0.1:5198'); await button('90 days').click(); await button('Start backtest').click()
 await page.locator('.chart-canvas').first().waitFor(); await saved()
 for (const count of [1, 2, 3]) {
  await page.locator(`input[name="chart-count"][value="${count}"]`).check(); await settle()
  for (const [width, height] of [[1440,1000],[1100,800]]) {
   await page.setViewportSize({width,height}); await settle(); await screenshot(`after-${count}-charts-${width}`)
   assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width)
   const toolbar = (await page.locator('.workspace-toolbar').boundingBox())!, chart = (await page.locator('.chart-canvas').first().boundingBox())!
   assert.ok(toolbar.y + toolbar.height <= chart.y)
   assert.equal(await page.locator('.trading-dock').count(), 0)
   assert.equal(await page.locator('.active-positions').count(), 0)
   assert.ok(toolbar.height <= (width === 1440 ? 44 : 80), `Toolbar too tall: ${toolbar.height}`)
   const buy = (await button('Buy').boundingBox())!, replay = (await page.getByRole('group',{name:'Market replay',exact:true}).boundingBox())!
   if(width === 1440) assert.ok(buy.x > replay.x + replay.width && Math.abs(buy.y-replay.y)<4)
   assert.equal(await page.locator('.pane-toolbar .instrument strong').first().innerText(),'EURUSD 6E')
   for(const label of ['Ready for a new setup','Entries fill at the next eligible M1 opening','Contract mappings and rollover events']) assert.equal(await page.getByText(label,{exact:true}).isVisible(),false)
   const clock = (await page.locator('.header-account time').boundingBox())!, pnl = (await page.getByLabel('Account PnL',{exact:true}).boundingBox())!
   assert.ok(clock.x+clock.width <= pnl.x && pnl.x-clock.x-clock.width <= 20)
   const info = page.locator('.app-header .execution-details > summary')
   await info.click(); assert.ok(await page.locator('.execution-popover').isVisible())
   const popover = (await page.locator('.execution-popover').boundingBox())!; assert.ok(popover.x >= 0 && popover.x+popover.width <= width)
   if(count===1) await screenshot(`execution-info-${width}`)
   await info.click(); assert.equal(await page.locator('.execution-popover').isVisible(),false)
   const stability=[]
   for(let id=0;id<count;id++) {
    const pane=page.locator('.chart-pane').nth(id), summary=pane.locator('.indicator-controls > summary')
    const boxes=async()=>Promise.all([pane.locator('select'),summary,pane.locator('.indicator-readiness'),pane.locator('.chart-canvas')].map(el=>el.boundingBox()))
    const closed=await boxes(), readiness=closed[2]!, row=(await pane.locator('.pane-toolbar').boundingBox())!
    assert.ok(readiness.y>=row.y && readiness.y+readiness.height<=row.y+row.height)
    await summary.click(); await settle(); const opened=await boxes(); assert.deepEqual(opened,closed)
    assert.ok(await pane.locator('.indicator-options').isVisible())
    if(id===0) await screenshot(`indicators-open-${count}-${width}`)
    await summary.click();await settle();assert.deepEqual(await boxes(),closed)
    stability.push({closed,opened})
   }
   evidence.checks[`layout-${count}-${width}`] = {toolbar,chart,clock,pnl,buy,replay,stability}
  }
  await page.setViewportSize({width:1440,height:1000}); await settle()
  for (let id = 0; id < count; id++) {
   const dataBefore = await page.evaluate(id => (globalThis as any).__uxCharts[id].series.data(),id), beforeMargin=await ranges()
   await pan(id,.8,.3)
   const margin = await page.evaluate(id => { const {chart,series}=(globalThis as any).__uxCharts[id], data=series.data(), range=chart.timeScale().getVisibleLogicalRange(), last=data.length-1; return {range,last,latest:data[last].time,plotWidth:chart.timeScale().width(),latestX:chart.timeScale().logicalToCoordinate(last),offset:range.to-last} },id)
   assert.ok(margin.offset > 26 && margin.offset <= 80.01,JSON.stringify(margin))
   assert.ok(margin.plotWidth-margin.latestX > margin.plotWidth*.2)
   assert.deepEqual(await page.evaluate(id=>(globalThis as any).__uxCharts[id].series.data(),id),dataBefore)
   for(let other=0;other<count;other++) if(other!==id) assert.deepEqual((await ranges())[other],beforeMargin[other])
   const savedMargin=(await record()).checkpoint
   assert.equal(savedMargin.workspace.viewport.charts[id].following,false)
   assert.ok(margin.latest*1000 <= savedMargin.replay.timestamp)
   evidence.checks[`future-margin-${count}-${id}`]=margin
   await screenshot(`future-margin-${count}-${id}`)
   const held=await ranges();await button('Next Candle').click();await settle();assert.deepEqual(await ranges(),held)
   const beforePan = await ranges(); await pan(id, .3, .55); const earlier = await ranges()
   assert.ok(earlier[id].to < beforePan[id].to - 1, `Chart ${id} stuck at right edge`)
   for (let other=0;other<count;other++) if(other!==id) assert.deepEqual(earlier[other],beforePan[other])
   await screenshot(`pan-earlier-${count}-${id}`)
   await pan(id,.55,.4); const later = await ranges();
   if(count===1) await screenshot('pan-later-1-0'); assert.ok(later[id].to > earlier[id].to + 1, JSON.stringify({count,id,beforePan,earlier,later}))
   evidence.checks[`pan-${count}-${id}`] = {before:beforePan,earlier,later}
  }
  const manual = await ranges(); await button('Next Candle').click(); await settle(); assert.deepEqual(await ranges(),manual)
 }
 await page.locator('input[name="chart-count"][value="1"]').check(); await settle()
 // Candles must have the highest series order on the price pane on every timeframe.
 for (const timeframe of ['M5','M15','H1','H4','D1']) {
  await page.getByLabel('Chart 1 timeframe',{exact:true}).selectOption(timeframe); await settle()
  const ordering = await page.evaluate(() => { const {chart,series}=(globalThis as any).__uxCharts[0]; return { candle:series.seriesOrder(), lines:chart.panes()[0].getSeries().filter((s:any)=>s!==series).map((s:any)=>({order:s.seriesOrder(),precision:s.options().priceFormat.precision,visible:s.options().visible})) } })
  for (const line of ordering.lines.filter((s:any)=>s.visible)) { assert.ok(line.order < ordering.candle); assert.equal(line.precision,5) }
  evidence.checks[`ordering-${timeframe}`]=ordering
 }
 await page.getByLabel('Chart 1 timeframe',{exact:true}).selectOption('H1'); await settle()
 await page.getByLabel('Sizing mode',{exact:true}).selectOption('manual'); await page.getByLabel('Volume (lots)',{exact:true}).fill('0.01')
 const initial = (await record()).checkpoint.trading, observed=initial.quote!.trade!.close, stop=Math.round((observed-.003)*100000)/100000
 await button('Buy').click(); await settle(); await selectStop(stop)
 assert.equal((await record()).checkpoint.trading.pending.length,0)
 await annotationFits(); await screenshot('draft-sl-tick-desktop')
 await page.locator('input[name="chart-count"][value="3"]').check(); await settle()
 assert.equal(await page.locator('.draft-stop-annotation').count(),3); await screenshot('draft-sl-tick-three-charts')
 await page.locator('input[name="chart-count"][value="1"]').check(); await settle()
 await button('Confirm draft stop-loss').click(); await saved()
 assert.equal((await record()).checkpoint.trading.pending.length,1)
 assert.match((await entryLines())[0][0].title,/Pending B1 \(est\.\)/)
 await screenshot('one-pending-entry')
 await button('Buy').click(); await settle(); await selectStop(stop)
 await button('Confirm draft stop-loss').click(); await saved()
 for (const pane of await entryLines()) { assert.equal(pane.length,1); assert.match(pane[0].title,/B1.*B2/); assert.equal(pane[0].lineStyle,1) }
 await screenshot('two-pending-entries'); const pending=(await record()).checkpoint.trading
 await restore(); assert.deepEqual((await record()).checkpoint.trading,pending)
 assert.match((await entryLines())[0][0].title,/Pending B1.*Pending B2/)
 await button('Next Candle').click(); await settle(); await saved()
 const filled=(await record()).checkpoint.trading; assert.equal(filled.positions.length,2)
 for (const pane of await entryLines()) { assert.equal(pane[0].price,filled.positions[0].entryPrice); assert.match(pane[0].title,/B1 · B2/); assert.ok(!pane[0].title.includes('Pending')) }
 evidence.checks.filledEntries=await entryLines(); await screenshot('two-filled-entries')
 // Future margin remains usable with real entry/SL overlays and a crosshair in the empty area.
 for(const [width,height] of [[1440,1000],[1100,800]]) {
  await page.setViewportSize({width,height});await settle()
  const prices=await page.evaluate(()=>(globalThis as any).__uxCharts[0].series.data())
  await pan(0,.8,.3)
  const geometry=await page.evaluate(stops=>{const v=(globalThis as any).__uxCharts[0],data=v.series.data(),last=data.length-1;v.chart.subscribeCrosshairMove((event:any)=>{v.lastPointerTime=event.time??null;v.pointerHasCandle=event.seriesData.has(v.series)});return {offset:v.chart.timeScale().getVisibleLogicalRange().to-last,latestX:v.chart.timeScale().logicalToCoordinate(last),plotWidth:v.chart.timeScale().width(),height:v.chart.panes()[0].getHeight(),levels:stops.map((p:any)=>({entry:v.series.priceToCoordinate(p.entryPrice),stop:v.series.priceToCoordinate(p.stopPrice)}))}},filled.positions)
  assert.ok(geometry.offset>26 && geometry.offset<=80.01)
  for(const level of geometry.levels) for(const y of [level.entry,level.stop]) assert.ok(y!==null && y>0 && y<geometry.height)
  const box=(await page.locator('.chart-canvas').first().boundingBox())!
  await page.mouse.move(box.x+Math.min(geometry.latestX+80,geometry.plotWidth-20),box.y+geometry.height*.5);await settle()
  const {pointerTime,hasCandle}=await page.evaluate(()=>{const v=(globalThis as any).__uxCharts[0];return {pointerTime:v.lastPointerTime,hasCandle:v.pointerHasCandle}})
  assert.equal(hasCandle,false)
  assert.deepEqual(await page.evaluate(()=>(globalThis as any).__uxCharts[0].series.data()),prices)
  evidence.checks[`margin-with-stops-${width}`]={...geometry,pointerTime,hasCandle}
  await screenshot(`margin-with-stops-${width}`)
 }
 await page.setViewportSize({width:1440,height:1000});await settle()

 // Existing Modify SL remains explicit: selecting or releasing never commits this draft.
 await button(`Modify SL ${filled.positions[0].id}`).click(); await settle(); await selectStop(stop)
 for (const [width,height] of [[1440,1000],[1100,800]]) {
  await page.setViewportSize({width,height}); await settle()
  await button('Confirm draft stop-loss').first().scrollIntoViewIfNeeded(); await settle()
  evidence.checks[`draft-edge-${width}`]=await annotationFits(); await screenshot(`draft-sl-tick-${width}`)
 }
 await page.keyboard.press('Escape'); await settle(); assert.equal(await page.locator('.draft-stop-annotation').count(),0)
 assert.deepEqual((await record()).checkpoint.trading,filled)
 await page.setViewportSize({width:1440,height:1000}); await settle()
 // Validation remains visible and invalid drafts cannot submit via the tick.
 await button(`Modify SL ${filled.positions[0].id}`).click(); await page.getByText('Enter price with keyboard',{exact:true}).click()
 await page.getByLabel('SL price',{exact:true}).fill((observed+.02).toFixed(5)); await settle()
 assert.equal(await button('Confirm draft stop-loss').isDisabled(),true); await annotationFits()
 await page.keyboard.press('Escape')
 // Confirm an SL modification at the smaller laptop width.
 await page.setViewportSize({width:1100,height:800});await settle()
 await button(`Modify SL ${filled.positions[0].id}`).click();await page.getByText('Enter price with keyboard',{exact:true}).click()
 const revisedStop=filled.positions[0].stopPrice+.0001
 await page.getByLabel('SL price',{exact:true}).fill(revisedStop.toFixed(5));await settle()
 await button('Confirm draft stop-loss').scrollIntoViewIfNeeded();await button('Confirm draft stop-loss').click();await saved()
 const modified=(await record()).checkpoint.trading.positions[0]
 assert.ok(Math.abs(modified.stopPrice-revisedStop)<.000001);assert.equal(modified.stopModifications.length,1)
 assert.equal(await page.locator('.draft-stop-annotation').count(),0);evidence.checks.laptopStopConfirmation=true
 await page.setViewportSize({width:1440,height:1000});await settle()
 // Every chart receives both entry identities, including narrow stacked panes.
 for(const count of [2,3]) {
  await page.locator(`input[name="chart-count"][value="${count}"]`).check(); await settle()
  assert.equal((await entryLines()).length,count)
  const coordinates = await page.evaluate(() => Object.values((globalThis as any).__uxCharts).slice(0,document.querySelectorAll('.chart-pane').length).map((v:any) => ({height:v.chart.panes()[0].getHeight(),entries:[...v.lines].map((l:any)=>l.options()).filter((l:any)=>/\b[BS][12]\b/.test(l.title)).map((l:any)=>v.series.priceToCoordinate(l.price))})))
  for(const pane of coordinates) for(const y of pane.entries) assert.ok(y!==null && y>=0 && y<=pane.height)
  evidence.checks[`visible-entries-${count}`]=coordinates
  for(const lines of await entryLines()) assert.match(lines.map((l:any)=>l.title).join(' '),/B1.*B2/)
  for(const [width,height] of [[1440,1000],[1100,800]]) { await page.setViewportSize({width,height}); await settle(); await screenshot(`entries-${count}-charts-${width}`); assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width) }
 }
 await page.setViewportSize({width:1440,height:1000}); await settle(); await saved()
 const checkpoint=(await record()).checkpoint, views=await ranges()
 await new Promise<void>(resolve=>{backend.close(()=>resolve());backend.closeAllConnections()});await storage.close()
 storage=new SessionStorage({directory:join(directory,'sessions')});backend=createApp(new HistoryService(new OfflineClient(),cache,{DATABENTO_TEST_BUDGET_USD:'0'}),()=>new Date(),storage)
 await new Promise<void>(resolve=>backend.listen(5199,'127.0.0.1',resolve));await restore()
 assert.deepEqual((await record()).checkpoint.trading,checkpoint.trading);assert.deepEqual(await ranges(),views)
 for(const lines of await entryLines()) assert.match(lines.map((l:any)=>l.title).join(' '),/B1.*B2/)
 await screenshot('entries-restored-after-backend-restart'); evidence.checks.durableRestore={entries:await entryLines(),views}
 assert.deepEqual(await manifest(),before);evidence.checks.cacheUnchanged=true
 assert.equal(evidence.providerRequests,0);assert.equal(evidence.paidSubmissions,0);assert.deepEqual(evidence.errors,[])
 await writeFile(`${output}/browser-evidence.json`,JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify({checks:Object.keys(evidence.checks),providerRequests:evidence.providerRequests,paidSubmissions:evidence.paidSubmissions,errors:evidence.errors},null,2))
} catch(error) { await screenshot('failure');await writeFile(`${output}/browser-failure.json`,JSON.stringify({...evidence,failure:String(error)},null,2));throw error }
finally {await browser.close();await vite.close();await new Promise<void>(resolve=>{backend.close(()=>resolve());backend.closeAllConnections()});await storage.close()}
