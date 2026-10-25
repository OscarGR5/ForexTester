// Offline Chromium verification. Uses the local cache read-only and temporary sessions.
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
const directory = await mkdtemp(join(tmpdir(), 'forextester-direct-stop-'))
const output = 'docs/direct-stop-drag-compact-toolbar'
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
const beforeCache = await manifest()
const storage = new SessionStorage({ directory: join(directory, 'sessions') })
const backend = createApp(new HistoryService(new OfflineClient(), cache, { DATABENTO_TEST_BUDGET_USD: '0' }), () => new Date(), storage)
await new Promise<void>(resolve => backend.listen(5199, '127.0.0.1', resolve))
// Verification-only access to public chart APIs. Inputs below use real Chromium events.
const vite = await createServer({ configFile: false, root: 'frontend', cacheDir: join(directory, 'vite'),
 plugins: [{ name: 'header-follow-observation', transform(code, id) {
  if (id.endsWith('/App.tsx')) return code.replace('synchronizer.advance(bounds)', 'globalThis.__uxSync = synchronizer; synchronizer.advance(bounds)').replace(/const trading = useTrading\(history, replay, hydration\);?/, `const trading = useTrading(history, replay, hydration);
    globalThis.__keyboardObservation = { source, replay, trading };`)
  if (!id.endsWith('/ChartPane.tsx')) return
  return code.replace('chartRef.current = chart', `
    globalThis.__uxCharts ??= {};
    const observed = { chart, series, stopLabels: stopLines.current.labels, lines: {}, crosshair: null };
    globalThis.__uxCharts[id] = observed;
    const add = chart.addSeries.bind(chart);
    chart.addSeries = (type, options, pane) => { const line = add(type, options, pane); observed.lines[options.title] = line; return line; };
    chart.subscribeCrosshairMove(event => { observed.crosshair = { point: event.point, time: event.time }; });
    chartRef.current = chart`)
 } }], server: { watch: null, hmr: false, host: '127.0.0.1', port: 5198, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:5199', changeOrigin: false } } } })
await vite.listen()
const browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'], executablePath: process.env.CHROMIUM_PATH ?? '/home/admin/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell' })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await context.newPage()
await page.addInitScript('globalThis.__name = target => target')
await page.route('**/*', route => {
 const url = new URL(route.request().url())
 if (url.hostname !== '127.0.0.1' || url.pathname === '/api/history/download') {
  if (url.pathname === '/api/history/download') evidence.paidSubmissions++
  return route.abort('blockedbyclient')
 }
 return route.continue()
})
page.on('pageerror', error => evidence.errors.push(error.message))
const button = (name: string) => page.getByRole('button', { name, exact: true })
const settle = () => page.waitForTimeout(250)
async function screenshot(name: string) { const path = `${output}/${name}.png`; await page.screenshot({ path }); evidence.screenshots.push(path) }
const observation = () => page.evaluate(() => { const { trading, replay } = (globalThis as any).__keyboardObservation; return { trading: trading.state, timestamp: replay.timestamp, reviewing: replay.reviewing } })
const saved = () => page.waitForFunction(() => document.querySelector('.save-state')?.textContent === 'Saved')
async function point(price: number, id = 0) {
 const box = (await page.locator('.chart-canvas').nth(id).boundingBox())!
 const y = await page.evaluate(({ price, id }) => (globalThis as any).__uxCharts[id].series.priceToCoordinate(price), { price, id })
 assert.ok(y !== null && y > 0 && y < box.height, `Price outside pane: ${y}`)
 return { x: box.x + 80, y: box.y + y }
}
async function order(stop: number, direction = 'Buy') {
 await button(direction).click(); await settle(); const at = await point(stop)
 await page.mouse.click(at.x, at.y); await button('Confirm order').click(); await saved()
}
async function layoutEvidence() {
 const result = await page.evaluate(() => {
  const box = (el: Element) => { const r = el.getBoundingClientRect(); return { x:r.x, y:r.y, right:r.right, bottom:r.bottom, width:r.width, height:r.height } }
  const strip = document.querySelector<HTMLElement>('.active-positions')!
  return { viewport:innerWidth, pageWidth:document.documentElement.scrollWidth, toolbar:box(document.querySelector('.workspace-toolbar')!),
   controls:Array.from(document.querySelectorAll('.dock-controls > label, .dock-controls > button, .dock-controls > span')).map(box),
   positions:Array.from(strip.children).map(box), strip:{...box(strip), scrollWidth:strip.scrollWidth, clientWidth:strip.clientWidth},
   data:Array.from(strip.children).map(el=>el.textContent) }
 })
 assert.equal(result.pageWidth,result.viewport)
 assert.ok(result.toolbar.height >= 38 && result.toolbar.height <= 54, JSON.stringify(result))
 const rows=[...result.controls,...result.positions]
 for (const row of rows) assert.ok(row.y>=result.toolbar.y && row.bottom<=result.toolbar.bottom,JSON.stringify(result))
 assert.ok(result.controls[2].right < result.strip.x)
 if(result.viewport===1440) assert.ok(result.strip.scrollWidth<=result.strip.clientWidth,JSON.stringify(result))
 return result
}
const views = () => page.evaluate(() => Array.from(document.querySelectorAll('.chart-canvas')).map((_,id) => (globalThis as any).__uxCharts[id].chart.timeScale().getVisibleLogicalRange()))
const round = (n: number) => Math.round(n*100000)/100000
async function geometry(pane = 0) {
 return page.evaluate(id => {
  const {chart,series,stopLabels}=(globalThis as any).__uxCharts[id]
  return { bounds:stopLabels.bounds, stops:stopLabels.stops, width:chart.timeScale().width(), height:chart.panes()[0].getHeight(),
   lines:stopLabels.stops.map((s:any)=>({id:s.id,y:series.priceToCoordinate(s.price)})) }
 },pane)
}
async function drag(id: string, price: number, mode: 'label'|'line', pane = 0, outcome: 'valid'|'invalid'|'Escape'|'pointercancel' = 'valid', capture?: string) {
 const before=(await observation()).trading, position=before.positions.find((p:any)=>p.id===id)!, beforeViews=await views()
 const box=(await page.locator('.chart-canvas').nth(pane).boundingBox())!, g=await geometry(pane)
 const row=g.bounds.find((r:any)=>r.id===id)!, actual=g.lines.find((r:any)=>r.id===id).y
 assert.ok(row,'Stop annotation must have rendered bounds')
 const from={x:box.x+(mode==='label'?row.x+10:80),y:box.y+(mode==='label'?row.top+row.height/2:actual)}
 await page.mouse.move(from.x,from.y); await page.mouse.down(); await settle()
 assert.equal(await page.locator('.stop-selector').count(),0)
 assert.match(await page.locator('.stop-drag-status[role="status"]').innerText(),new RegExp(id))
 const target=await point(price,pane), to={x:from.x,y:target.y+(mode==='label'?from.y-(box.y+actual):0)}
 await page.mouse.move(to.x,to.y,{steps:8}); await settle()
 assert.deepEqual((await observation()).trading,before,'Drag preview must not change durable trading state')
 const preview=await page.locator('.stop-drag-status[role="status"]').innerText()
 assert.match(preview,new RegExp(price.toFixed(5)))
 if(outcome==='valid') assert.match(preview,/Risk \$/)
 if(capture) await screenshot(capture)
 if(outcome==='Escape') await page.keyboard.press('Escape')
 if(outcome==='pointercancel') await page.locator('.chart-canvas').nth(pane).dispatchEvent('pointercancel')
 await page.mouse.up(); await settle(); await saved()
 const after=(await observation()).trading
 if(outcome!=='valid') assert.deepEqual(after,before)
 else {
  const updated=after.positions.find((p:any)=>p.id===id)
  assert.equal(updated.stopPrice,price)
  assert.equal(updated.stopModifications.length,position.stopModifications.length+1)
  assert.equal(updated.stopEffectiveAfter,before.observedTimestamp)
  for(const other of before.positions.filter((p:any)=>p.id!==id)) assert.deepEqual(after.positions.find((p:any)=>p.id===other.id),other)
 }
 assert.deepEqual(await views(),beforeViews,'Stop dragging must preserve independent chart time ranges')
 return {pane,mode,id,from,to,price,outcome,preview}
}
async function assertCompact() {
 const strip=page.locator('.active-positions')
 assert.equal(await strip.locator('details, .position-stop, .position-details').count(),0)
 assert.equal(await page.getByRole('button',{name:/Modify SL|Choose another level/}).count(),0)
 const texts=await strip.locator(':scope > div').allTextContents()
 for(const text of texts) {
  assert.doesNotMatch(text,/SL|pips|Setup|outcome/)
  assert.match(text,/^(?:Pending [BS][12].*riskCancel|[BS][12].*lotsEst. net -?\$.*Close)$/)
 }
 return texts
}
async function draftChecks(price: number) {
 await button('Buy').click(); await settle()
 const at=await point(price-.002)
 await page.mouse.move(at.x,at.y); await settle()
 assert.match(await page.locator('.draft-stop-annotation').first().innerText(),/pips/)
 await page.mouse.click(at.x,at.y); await settle()
 assert.equal(await button('Choose another level').count(),0)
 const before=(await observation()).trading
 await page.mouse.move(at.x,at.y); await page.mouse.down(); await page.mouse.move(at.x,at.y-8,{steps:8}); await page.mouse.up(); await settle()
 assert.deepEqual((await observation()).trading,before)
 assert.equal(await button('Confirm draft stop-loss').first().isEnabled(),true)
 assert.equal(await button('Confirm order').isEnabled(),true)
 await screenshot('initial-draft-drag')
 await button('Cancel placement').click(); await settle()
 // Keyboard fallback and the chart confirmation tick still submit an initial order.
 await button('Buy').click(); await page.getByText('Enter price with keyboard',{exact:true}).click()
 await page.getByRole('spinbutton',{name:'SL price',exact:true}).fill(round(price-.003).toFixed(5)); await settle()
 await button('Confirm draft stop-loss').first().click(); await saved()
 assert.equal((await observation()).trading.pending.length,1)
 evidence.checks.keyboardAndTick=true
}
try {
 await page.goto('http://127.0.0.1:5198'); await button('90 days').click(); await button('Start backtest').click()
 await page.locator('.chart-canvas').first().waitFor(); await settle(); await saved()
 let market=round((await observation()).trading.quote.trade.close)
 await draftChecks(market)
 evidence.checks.onePending=await assertCompact(); await screenshot('one-pending')
 await button('Next Candle').click(); await saved(); evidence.checks.oneOpen=await assertCompact()
 await order(market-.0031); evidence.checks.mixed=await assertCompact(); await screenshot('mixed-open-pending')
 await button('Next Candle').click(); await saved(); await settle()
 let state=(await observation()).trading
 assert.equal(state.positions.length,2)
 const [first,second]=state.positions.map((p:any)=>p.id), base=round(market-.003)
 const mutations:any[]=[]
 for(const count of [1,2,3]) {
  await page.locator(`input[name="chart-count"][value="${count}"]`).check(); await settle()
  for(const [width,height] of [[1440,1000],[1100,800],[1000,800]]) {
   await page.setViewportSize({width,height}); await settle()
   // Fix only the verification view so both close lines remain visible in every pane.
   await page.evaluate(({market,count})=>{
    for(let id=0;id<count;id++) (globalThis as any).__uxCharts[id].series.priceScale().setVisibleRange({from:market-.006,to:market+.003})
   },{market,count}); await settle()
   evidence.checks[`layout-${count}-${width}`]=await layoutEvidence()
   await assertCompact(); await screenshot(`after-${count}-${width}`)
   for(let pane=0;pane<count;pane++) {
    // Restore a nearby pair using the real annotations when previous drags moved them.
    for(const [id,price] of [[first,base],[second,round(base-.0001)]] as const) {
     if((await observation()).trading.positions.find((p:any)=>p.id===id).stopPrice!==price) mutations.push(await drag(id,price,'label',pane))
    }
    const g=await geometry(pane), distance=Math.abs(g.lines[0].y-g.lines[1].y)
    assert.ok(distance>0 && distance<7,`Nearby line distance must be under tolerance: ${distance}`)
    // Each nearest actual line selects its own ID even when both are in tolerance.
    mutations.push(await drag(first,round(base+.0001),'line',pane))
    mutations.push(await drag(second,round(base-.00005),'line',pane))
    // Test the painted annotations themselves, including the displaced second row.
    mutations.push(await drag(first,base,'label',pane))
    mutations.push(await drag(second,round(base-.0001),'label',pane,'valid',pane===count-1?`label-sl2-${count}-${width}`:undefined))
   }
  }
 }
 evidence.checks.independentNearbyDrags=mutations
 await page.setViewportSize({width:1440,height:1000}); await page.locator('input[name="chart-count"][value="1"]').check(); await settle()
 // Coincident shared line must not pick an arbitrary position, while both separated labels work.
 await drag(second,base,'label')
 state=(await observation()).trading
 const shared=await point(base)
 await page.mouse.move(shared.x,shared.y); await page.mouse.down(); await page.mouse.move(shared.x,shared.y-12,{steps:8}); await page.mouse.up(); await settle()
 assert.deepEqual((await observation()).trading,state)
 assert.equal(await page.locator('.stop-drag-status').count(),0)
 await screenshot('coincident-stops')
 evidence.checks.coincident=[await drag(first,round(base+.0001),'label'),await drag(first,base,'label'),await drag(second,round(base+.0002),'label')]
 evidence.checks.cancellation=[await drag(first,round(base+.0003),'label',0,'Escape','escape-preview'),await drag(second,round(base+.0004),'label',0,'pointercancel')]
 // Invalid side and combined-risk validation both retain confirmed values.
 const current=round((await observation()).trading.quote.trade.close)
 evidence.checks.invalid=await drag(first,round(current+.0005),'label',0,'invalid','invalid-preview')
 evidence.checks.invalidRisk=await drag(first,round(base-.002),'label',0,'invalid','invalid-risk-preview')
 // Reload restores the same position identity, stops, and history.
 const checkpoint=(await observation()).trading
 await page.reload(); await button('Resume backtest').click(); await page.locator('.chart-canvas').first().waitFor(); await settle(); await saved()
 assert.deepEqual((await observation()).trading,checkpoint); await assertCompact(); await screenshot('restored')
 // Historical review and playback restrict direct chart mutation.
 const at=await point(checkpoint.positions[0].stopPrice)
 await page.mouse.click(at.x,at.y-50); await page.keyboard.press('Shift+ArrowLeft'); await settle()
 assert.equal((await observation()).reviewing,true); assert.equal(await page.locator('.active-positions').count(),0)
 await page.mouse.move(at.x,at.y); await page.mouse.down(); await page.mouse.move(at.x,at.y-10); await page.mouse.up(); await settle()
 assert.deepEqual((await observation()).trading,checkpoint)
 await button('Return to current replay').click(); await button('Play').click(); await settle()
 assert.equal(await button(`Close ${first}`).isEnabled(),false)
 const playingStops=(await observation()).trading.positions.map((p:any)=>({id:p.id,price:p.stopPrice,changes:p.stopModifications}))
 await page.mouse.move(at.x,at.y); await page.mouse.down(); await page.mouse.move(at.x,at.y-10); await page.mouse.up(); await settle()
 assert.equal(await page.locator('.stop-drag-status[role="status"]').count(),0)
 assert.deepEqual((await observation()).trading.positions.map((p:any)=>({id:p.id,price:p.stopPrice,changes:p.stopModifications})),playingStops)
 await button('Pause').click(); await settle()
 // Real Close and Cancel actions still use their full durable IDs.
 await button(`Close ${second}`).click(); await button('Next Candle').click(); await saved()
 assert.equal((await observation()).trading.positions.length,1)
 await button(`Close ${first}`).click(); await button('Next Candle').click(); await saved()
 assert.equal((await observation()).trading.positions.length,0)
 market=round((await observation()).trading.quote.trade.close)
 await order(market-.003); await order(market-.0031)
 evidence.checks.twoPending=await assertCompact(); await screenshot('two-pending')
 for(const entry of (await observation()).trading.pending) await button(`Cancel entry ${entry.id}`).click()
 await saved(); assert.equal((await observation()).trading.pending.length,0)
 evidence.checks.actions=true; evidence.checks.reviewAndReplayRestrictions=true
 assert.deepEqual(await manifest(),beforeCache); evidence.checks.cacheUnchanged=true; evidence.cacheManifest=beforeCache
 assert.equal(evidence.providerRequests,0); assert.equal(evidence.paidSubmissions,0); assert.deepEqual(evidence.errors,[])
 await writeFile(`${output}/browser-evidence.json`,JSON.stringify(evidence,null,2)+'\n')
 console.log(JSON.stringify({checks:Object.keys(evidence.checks),drags:mutations.length,providerRequests:evidence.providerRequests,paidSubmissions:evidence.paidSubmissions,errors:evidence.errors},null,2))
} catch(error) { await screenshot('failure'); await writeFile(`${output}/browser-failure.json`,JSON.stringify({...evidence,failure:String(error)},null,2)); throw error }
finally { await browser.close(); await vite.close(); await new Promise<void>(resolve=>{backend.close(()=>resolve());backend.closeAllConnections()}); await storage.close() }
