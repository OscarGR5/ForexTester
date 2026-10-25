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
const directory = await mkdtemp(join(tmpdir(), 'forextester-live-draft-'))
const output = 'docs/live-draft-sl-and-inline-positions'
await mkdir(output, { recursive: true })
const evidence: any = { providerRequests: 0, paidSubmissions: 0, screenshots: [], errors: [], checks: {} }
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
    const observed = { chart, series, lines: {}, crosshair: null };
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
async function annotation(id = 0) {
 return page.locator('.draft-stop-annotation').nth(id).evaluate(el => {
  const r=el.getBoundingClientRect(), plot=el.parentElement!.getBoundingClientRect()
  return { text:el.textContent, price:Number((el as HTMLElement).dataset.price), x:r.x, right:r.right, y:r.y, bottom:r.bottom, plot:{x:plot.x,y:plot.y,right:plot.right,bottom:plot.bottom} }
 })
}
async function liveDraft(direction: 'Buy' | 'Sell', reference: number, id = 0) {
 await button(direction).click(); await settle()
 const sign=direction==='Buy' ? -1 : 1, values=[]
 const before=await observation()
 for(const distance of [.001,.002]) {
  const at=await point(reference+sign*distance,id); await page.mouse.move(at.x,at.y,{steps:8}); await settle()
  const label=await annotation(id); values.push(label)
  assert.match(label.text!,new RegExp(`${(Math.abs(label.price-reference)/.0001).toFixed(1)} pips`))
  assert.ok(label.x>=label.plot.x && label.right<=label.plot.right && label.y>=label.plot.y && label.bottom<=label.plot.bottom)
  await screenshot(`live-${direction.toLowerCase()}-${distance===.001 ? 'near' : 'far'}-${id}`)
 }
 assert.notEqual(values[0].text,values[1].text)
 assert.deepEqual((await observation()).trading,before.trading)
 assert.equal(await button('Confirm draft stop-loss').nth(id).isVisible(),false)
 // Select, then drag the draft without a durable mutation or confirmation.
 const start=await point(values[1].price,id); await page.mouse.click(start.x,start.y); await settle()
 assert.equal(await button('Confirm order').isEnabled(),true)
 await page.mouse.move(start.x,start.y); await page.mouse.down(); await page.mouse.move(start.x,start.y+sign*8,{steps:8}); await page.mouse.up(); await settle()
 const adjusted=await annotation(id)
 assert.notEqual(adjusted.price,values[1].price)
 assert.deepEqual((await observation()).trading,before.trading)
 assert.equal(await button('Confirm order').isEnabled(),true)
 evidence.checks[`live-${direction}-${id}`]={values,adjusted}
 // Wrong side stays visibly invalid, including after release.
 const invalid=await point(reference-sign*.001,id)
 const from=await point(adjusted.price,id)
 await page.mouse.move(from.x,from.y); await page.mouse.down(); await page.mouse.move(invalid.x,invalid.y,{steps:12}); await page.mouse.up(); await settle()
 assert.match((await annotation(id)).text!,/Invalid SL side/)
 assert.equal(await button('Confirm order').isEnabled(),false)
 assert.equal(await button('Confirm draft stop-loss').nth(id).isEnabled(),false)
 await screenshot(`invalid-${direction.toLowerCase()}-${id}`)
 await page.keyboard.press('Escape'); await settle()
 assert.equal(await page.locator('.draft-stop-annotation').count(),0)
 assert.deepEqual((await observation()).trading,before.trading)
}
try {
 await page.goto('http://127.0.0.1:5198'); await button('90 days').click(); await button('Start backtest').click()
 await page.locator('.chart-canvas').first().waitFor(); await settle(); await saved()
 let observed=(await observation()).trading.quote.trade.close
 // All chart topologies support both sides, hover updates and selected-line drags.
 for(const count of [1,2,3]) {
  await page.locator(`input[name="chart-count"][value="${count}"]`).check(); await settle()
  for(const direction of ['Buy','Sell'] as const) await liveDraft(direction,observed,count-1)
 }
 await page.locator('input[name="chart-count"][value="1"]').check(); await settle()
 // Two pending entries, mixed states, then two open positions.
 await order(observed-.003)
 evidence.checks.onePending=await layoutEvidence(); await screenshot('one-pending')
 await button('Next Candle').click(); await saved(); assert.equal((await observation()).trading.positions.length,1)
 evidence.checks.oneOpen=await layoutEvidence()
 observed=(await observation()).trading.quote.trade.close
 await order(observed-.0031); evidence.checks.mixed=await layoutEvidence(); await screenshot('mixed-open-pending')
 await button('Next Candle').click(); await saved(); let state=(await observation()).trading
 assert.equal(state.positions.length,2)
 const [first,second]=state.positions.map((p:any)=>p.id)
 for(const count of [1,2,3]) {
  await page.locator(`input[name="chart-count"][value="${count}"]`).check(); await settle()
  for(const [width,height] of [[1440,1000],[1100,800],[1000,800]]) {
   await page.setViewportSize({width,height}); await settle()
   evidence.checks[`inline-${count}-${width}`]=await layoutEvidence(); await screenshot(`inline-${count}-${width}`)
   const strip=page.getByRole('region',{name:'Pending and open positions'})
   if(width<1440) {
    await strip.evaluate(el=>{el.scrollLeft=0}); await strip.hover(); await page.mouse.wheel(240,0); await settle()
    const wheel=await strip.evaluate(el=>el.scrollLeft); assert.ok(wheel>0)
    await strip.evaluate(el=>{el.scrollLeft=0}); await strip.focus(); await page.keyboard.press('ArrowRight'); await settle()
    const keyboard=await strip.evaluate(el=>el.scrollLeft); assert.ok(keyboard>0)
    await strip.evaluate(el=>{el.scrollLeft=0})
    const bar=(await strip.boundingBox())!; await page.mouse.click(bar.x+bar.width-4,bar.y+bar.height-4); await settle()
    const mouse=await strip.evaluate(el=>el.scrollLeft); assert.ok(mouse>0)
    evidence.checks[`scroll-${count}-${width}`]={wheel,keyboard,mouse}
   }
   await strip.focus(); await page.keyboard.press('End'); await settle()
   await button(`Close ${second}`).focus()
   const closeBox=(await button(`Close ${second}`).boundingBox())!, stripBox=(await strip.boundingBox())!
   assert.ok(closeBox.x>=stripBox.x && closeBox.x+closeBox.width<=stripBox.x+stripBox.width)
   const details=page.locator('.position-details summary').first(); await details.focus(); await page.keyboard.press('Enter')
   assert.equal(await page.locator('.position-details').first().getAttribute('open'),'')
   assert.match(await page.locator('.position-detail-text').first().innerText(),new RegExp(first))
   await page.keyboard.press('Enter')
   await button(`Modify SL ${first}`).click(); await settle()
   const current=(await observation()).trading.quote.trade.close, at=await point(current-.001,count-1)
   await page.mouse.move(at.x,at.y); await settle()
   const label=await annotation(count-1)
   assert.match(label.text!,/pips/)
   await screenshot(`draft-${count}-${width}`)
   const canvas=(await page.locator('.chart-canvas').nth(count-1).boundingBox())!
   const bounds=await page.evaluate(id=>{const {chart}= (globalThis as any).__uxCharts[id]; return {width:chart.timeScale().width(),height:chart.panes()[0].getHeight()}},count-1)
   for(const y of [2,bounds.height-2]) {
    await page.mouse.move(canvas.x+bounds.width-2,canvas.y+y); await settle()
    const edge=await annotation(count-1)
    assert.ok(edge.x>=canvas.x && edge.right<=canvas.x+bounds.width && edge.y>=canvas.y && edge.bottom<=canvas.y+bounds.height,JSON.stringify(edge))
   }
   await page.keyboard.press('Escape'); await settle()
  }
 }
 await page.setViewportSize({width:1440,height:1000}); await page.locator('input[name="chart-count"][value="1"]').check(); await settle()
 // Playback preserves the row and disables position actions.
 for(const [width,height] of [[1440,1000],[1000,800]]) {
  await page.setViewportSize({width,height}); await button('Play').click(); await settle()
  assert.equal(await button(`Modify SL ${first}`).isEnabled(),false)
  assert.equal(await button(`Close ${first}`).isEnabled(),false)
  evidence.checks[`playback-${width}`]=await layoutEvidence()
  await button('Pause').click(); await settle()
 }
 await page.setViewportSize({width:1440,height:1000}); await settle()
 // Modify SL distance uses market rather than original entry. Release remains a draft.
 await button(`Modify SL ${first}`).click(); await settle()
 const ref=(await observation()).trading.quote.trade.close, at=await point(ref-.001)
 await page.mouse.move(at.x,at.y); await settle(); await screenshot('modify-sl-live')
 await page.mouse.click(at.x,at.y); await settle()
 const before=(await observation()).trading
 await page.mouse.move(at.x,at.y); await page.mouse.down(); await page.mouse.move(at.x,at.y+10,{steps:8}); await page.mouse.up(); await settle()
 assert.deepEqual((await observation()).trading,before); await screenshot('modify-sl-selected')
 await button('Confirm draft stop-loss').first().dblclick(); await saved(); await settle()
 state=(await observation()).trading
 assert.equal(state.positions[0].stopModifications.length,before.positions[0].stopModifications.length+1)
 // Confirmed SL drag continues to apply on valid release, once.
 const confirmed=await point(state.positions[0].stopPrice)
 await page.mouse.move(confirmed.x,confirmed.y); await page.mouse.down(); await page.mouse.move(confirmed.x,confirmed.y-8,{steps:8}); await settle()
 assert.equal((await observation()).trading.positions[0].stopPrice,state.positions[0].stopPrice)
 await page.mouse.up(); await settle(); await saved()
 assert.equal((await observation()).trading.positions[0].stopModifications.length,state.positions[0].stopModifications.length+1)
 evidence.checks.confirmedDrag=true
 const checkpoint=(await observation()).trading
 await page.reload(); await button('Resume backtest').click(); await page.locator('.chart-canvas').first().waitFor(); await saved(); await settle()
 assert.deepEqual((await observation()).trading,checkpoint)
 evidence.checks.restored=await layoutEvidence(); await screenshot('restored')
 // Historical review cannot mutate the two-position checkpoint.
 const box=(await page.locator('.chart-canvas').first().boundingBox())!
 await page.mouse.click(box.x+80,box.y+80); await page.keyboard.press('Shift+ArrowLeft'); await settle()
 assert.equal((await observation()).reviewing,true); assert.equal(await button('Buy').isEnabled(),false)
 assert.equal(await page.locator('.active-positions').count(),0); assert.deepEqual((await observation()).trading,checkpoint)
 await screenshot('historical-review'); await button('Return to current replay').click(); await settle()
 await button(`Close ${second}`).click(); await button('Next Candle').click(); await saved()
 assert.equal((await observation()).trading.positions.length,1)
 await button(`Close ${first}`).click(); await button('Next Candle').click(); await saved()
 assert.equal((await observation()).trading.positions.length,0)
 observed=(await observation()).trading.quote.trade.close
 await order(observed-.003); await order(observed-.0031)
 evidence.checks.twoPending=await layoutEvidence(); await screenshot('two-pending')
 state=(await observation()).trading
 for(const entry of state.pending) await button(`Cancel entry ${entry.id}`).click()
 await saved(); assert.equal((await observation()).trading.pending.length,0)
 evidence.checks.actions=true
 assert.deepEqual(await manifest(),beforeCache); evidence.checks.cacheUnchanged=true
 assert.equal(evidence.providerRequests,0); assert.equal(evidence.paidSubmissions,0); assert.deepEqual(evidence.errors,[])
 await writeFile(`${output}/browser-evidence.json`,JSON.stringify(evidence,null,2)+'\n')
 console.log(JSON.stringify({checks:Object.keys(evidence.checks),providerRequests:evidence.providerRequests,paidSubmissions:evidence.paidSubmissions,errors:evidence.errors},null,2))
} catch(error) { await screenshot('failure'); await writeFile(`${output}/browser-failure.json`,JSON.stringify({...evidence,failure:String(error)},null,2)); throw error }
finally { await browser.close(); await vite.close(); await new Promise<void>(resolve=>{backend.close(()=>resolve());backend.closeAllConnections()}); await storage.close() }
