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
const directory = await mkdtemp(join(tmpdir(), 'forextester-header-follow-'))
const output = 'docs/replay-header-and-auto-follow'
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
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? '/home/admin/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell' })
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
const states = () => page.evaluate(() => Array.from(document.querySelectorAll('.chart-canvas'), (_, id) => {
 const { chart, series, lines } = (globalThis as any).__uxCharts[id]
 return { time: chart.timeScale().getVisibleLogicalRange(), price: series.priceScale().getVisibleRange(), auto: series.priceScale().options().autoScale,
  candles: series.data().length, last: series.data().at(-1), widths: Object.fromEntries(Object.entries(lines).map(([key, line]: any) => [key, line.options().lineWidth])) }
}))
const observation = () => page.evaluate(() => {
 const { replay, trading } = (globalThis as any).__keyboardObservation
 return { count: replay.count, displayCount: replay.displayCount, timestamp: replay.timestamp, reviewing: replay.reviewing, blocked: replay.blocked,
  executionCursor: trading.executionCursor, trading: trading.state, equityCount: trading.equity.count, cash: trading.equity.cashUsd }
})
const geometry = () => page.evaluate(() => Array.from(document.querySelectorAll('.chart-canvas'), (_, id) => {
 const { chart, series } = (globalThis as any).__uxCharts[id], scale = chart.timeScale(), data = series.data(), last = data.at(-1)
 return { range: scale.getVisibleLogicalRange(), latestX: scale.timeToCoordinate(last.time), plotWidth: scale.width(),
  last: data.length - 1, time: last.time, close: last.close, following: (globalThis as any).__uxSync.snapshot().charts[id].following }
}))
function visible(v: any) { assert.ok(v.latestX !== null && v.latestX > 0 && v.latestX < v.plotWidth - 1, JSON.stringify(v)) }
async function pan(id: number, from: number, to: number) {
 const box = (await page.locator('.chart-canvas').nth(id).boundingBox())!
 await page.mouse.move(box.x + box.width * from, box.y + 90); await page.mouse.down()
 await page.mouse.move(box.x + box.width * to, box.y + 90, { steps: 20 }); await page.mouse.up(); await settle()
}
async function panAway(id: number) {
 for(let attempt=0;attempt<5;attempt++) {
  await pan(id,.1,.85)
  const g=(await geometry())[id]; if(g.latestX>g.plotWidth) return
 }
 throw Error(`Could not pan chart ${id} away from the latest candle`)
}
async function layoutEvidence() {
 const result = await page.evaluate(() => {
  const selectors = ['.app-header h1', '.header-session', '.execution-details > summary', '.header-replay', '.header-account', '.app-header > button']
  const boxes = selectors.map(selector => { const r = document.querySelector(selector)!.getBoundingClientRect(); return { selector, x: r.x, y: r.y, right: r.right, bottom: r.bottom } })
  const controls = Array.from(document.querySelectorAll('.header-replay > button, .header-replay > label, .header-replay > .layout-controls, .replay-state')).map(el => { const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,right:r.right,bottom:r.bottom} })
  const pnl=document.querySelector('.account-pnl strong')!, old=pnl.textContent
  pnl.textContent='$-12345.67 · -12.35%'
  const pnlBox=pnl.parentElement!.getBoundingClientRect(), account=document.querySelector('.header-account')!.getBoundingClientRect()
  const stress={left:pnlBox.left,right:pnlBox.right,containerLeft:account.left,containerRight:account.right}
  pnl.textContent=old
  return { boxes, controls, stress, width: document.documentElement.scrollWidth, viewport: innerWidth }
 })
 assert.equal(result.width, result.viewport)
 assert.ok(result.stress.left>=result.stress.containerLeft && result.stress.right<=result.stress.containerRight,JSON.stringify(result.stress))
 for (const group of [result.boxes, result.controls]) for (let a=0;a<group.length;a++) for(let b=a+1;b<group.length;b++) {
  const x=group[a], y=group[b]; assert.ok(x.right <= y.x + .5 || y.right <= x.x + .5 || x.bottom <= y.y + .5 || y.bottom <= x.y + .5, JSON.stringify({x,y}))
 }
 return result
}
try {
 await page.goto('http://127.0.0.1:5198'); await button('90 days').click(); await button('Start backtest').click()
 await page.locator('.chart-canvas').first().waitFor(); await settle()
 for (const count of [1,2,3]) {
  await page.locator(`input[name="chart-count"][value="${count}"]`).check(); await settle()
  if (count > 1) await page.getByLabel('Chart 2 timeframe', {exact:true}).selectOption('M5')
  if (count > 2) await page.getByLabel('Chart 3 timeframe', {exact:true}).selectOption('M15')
  for (const [width,height] of [[1440,1000],[1100,800],[1000,800]]) {
   await page.setViewportSize({width,height}); await settle()
   evidence.checks[`layout-${count}-${width}`] = await layoutEvidence()
   for(const name of ['Play','Pause','Next Candle','Finish backtest']) assert.equal(await page.locator('.app-header').getByRole('button',{name,exact:true}).count(),1)
   assert.equal(await page.locator('.workspace-toolbar .header-replay').count(),0)
   assert.equal(await page.locator('.workspace-toolbar').getByRole('button',{name:'Buy',exact:true}).count(),1)
   await screenshot(`after-${count}-${width}`)
   const toolbar = await page.locator('.pane-toolbar').first().boundingBox()
   await page.locator('.indicator-controls > summary').first().click()
   assert.equal(await page.locator('.indicator-readiness').first().isVisible(),true)
   assert.deepEqual(await page.locator('.pane-toolbar').first().boundingBox(),toolbar)
   if(count===1 && width===1440) await screenshot('indicators-readiness')
   await page.keyboard.press('Escape')
   assert.equal(await page.locator('.indicator-readiness').first().isVisible(),false)
   await page.getByLabel('Execution details',{exact:true}).click()
   const info=(await page.locator('.execution-popover').boundingBox())!
   assert.ok(info.x>=0 && info.x+info.width<=width,JSON.stringify({width,info}))
   await page.keyboard.press('Escape')
  }
  await page.setViewportSize({width:1440,height:1000}); await settle()
  if(count===1) {
   await page.getByLabel('Chart 1 timeframe',{exact:true}).selectOption('M5'); await settle()
   let box=(await page.locator('.chart-canvas').first().boundingBox())!
   await page.mouse.move(box.x+200,box.y+90); for(let zoom=0;zoom<3;zoom++) { await page.mouse.wheel(0,-700); await settle() }
   await button('Play').click()
   const v=(await geometry())[0], spacing=v.plotWidth/(v.range.to-v.range.from)
   const shift=Math.max(0,(v.range.to-v.last-4)*spacing)
   await page.mouse.move(box.x+200,box.y+90); await page.mouse.down()
   await page.mouse.move(box.x+200+shift,box.y+90,{steps:3}); await page.mouse.up()
   await page.mouse.move(5,5); await page.waitForTimeout(100)
   const manual=(await geometry())[0]; visible(manual); assert.equal(manual.following,false,JSON.stringify({v,shift,manual}))
   await screenshot('running-before-boundary')
   await page.waitForFunction(()=>(globalThis as any).__uxSync.snapshot().charts[0].following,{},{timeout:12000})
   const recovered=(await geometry())[0]; visible(recovered)
   assert.ok(Math.abs(recovered.range.to-recovered.last-12)<.01)
   assert.ok(Math.abs(recovered.range.to-recovered.range.from-(manual.range.to-manual.range.from))<.01)
   await screenshot('running-after-boundary'); await button('Pause').click()
   evidence.checks.runningBoundary={manual,recovered}
   await page.getByLabel('Chart 1 timeframe',{exact:true}).selectOption('H1'); await settle()
  }
  // Historical panning is unrestricted until the next forward observation.
  await panAway(0)
  const paused=(await geometry())[0]; assert.ok(paused.latestX > paused.plotWidth)
  await page.waitForTimeout(1700); assert.deepEqual((await geometry())[0],paused)
  await button('Next Candle').click(); await settle()
  const stepped=(await geometry())[0]; visible(stepped); assert.equal(stepped.following,true)
  assert.ok(Math.abs(stepped.range.to-stepped.range.from-(paused.range.to-paused.range.from))<.01)
  evidence.checks[`next-candle-${count}`]={before:paused,after:stepped}
  // Reproduce with real mouse navigation during running playback. No later chart click.
  await page.getByLabel('Replay speed',{exact:true}).selectOption('1'); await button('Play').click()
  await pan(0,.1,.85)
  await page.mouse.move(5,5)
  await page.waitForTimeout(2100)
  const recovered=(await geometry())[0]; visible(recovered); assert.equal(recovered.following,true)
  await button('Pause').click(); await settle()
  evidence.checks[`running-pan-${count}`]=recovered
  await screenshot(`auto-follow-recovered-${count}`)
  for(let id=0;id<count;id++) {
   if(count>1) await pan((id+1)%count,.6,.55)
   await panAway(id)
   const before=await geometry(); assert.equal(before[id].following,false)
   const box=(await page.locator('.chart-canvas').nth(id).boundingBox())!
   await page.mouse.click(box.x+80,box.y+80)
   await page.keyboard.press('Shift+ArrowRight'); await settle()
   const after=await geometry(); visible(after[id]); assert.equal(after[id].following,true)
   for(let other=0;other<count;other++) if(other!==id) {
    assert.equal(after[other].following,before[other].following)
    if(!before[other].following) assert.deepEqual(after[other].range,before[other].range)
   }
   evidence.checks[`keyboard-recovery-${count}-${id}`]={before,after}
  }
 }
 // Higher-timeframe updates can change the tail without adding a bar.
 await page.locator('input[name="chart-count"][value="1"]').check(); await settle()
 for(const timeframe of ['M5','M15','H1','H4','D1']) {
  await page.getByLabel('Chart 1 timeframe',{exact:true}).selectOption(timeframe); await settle()
  // Start immediately after a timeframe step's final minute, then advance once into a new bar.
  await page.locator('.chart-canvas').first().click({position:{x:80,y:80}})
  await page.keyboard.press('Shift+ArrowRight'); await settle(); await button('Next Candle').click(); await settle()
  for(let attempt=0;attempt<4;attempt++) {
   await pan(0,.1,.85)
   const g=(await geometry())[0]; if(g.latestX > g.plotWidth) break
  }
  const before=(await geometry())[0]; assert.ok(before.latestX > before.plotWidth,JSON.stringify({timeframe,before}))
  await button('Next Candle').click(); await settle()
  const after=(await geometry())[0]; evidence.checks[`partial-${timeframe}`]={before,after}; visible(after); assert.equal(after.last,before.last)
  assert.equal(after.following,true,JSON.stringify({timeframe,before,after}))
 }
 await page.getByLabel('Chart 1 timeframe',{exact:true}).selectOption('M5'); await settle()
 await page.getByLabel('Replay speed',{exact:true}).selectOption('100')
 await button('Play').click(); await pan(0,.25,.65); await page.mouse.move(5,5)
 await page.waitForTimeout(1800)
 for(const g of await geometry()) visible(g)
 await button('Pause').click(); await settle()
 evidence.checks.fastReplay=await geometry(); await screenshot('100x-recovery')
 // Review's cutoff remains authoritative and manual historical view stays put.
 await page.locator('.chart-canvas').first().click({position:{x:80,y:80}})
 await page.keyboard.press('Shift+ArrowLeft'); await settle()
 assert.equal((await observation()).reviewing,true)
 await pan(0,.25,.65); const review=(await geometry())[0]
 await page.keyboard.press('Shift+ArrowLeft'); await settle()
 const earlier=(await geometry())[0]; assert.equal(earlier.range.to,review.range.to); assert.equal(earlier.following,false)
 assert.equal(await button('Play').isDisabled(),true); assert.equal(await button('Next Candle').isDisabled(),true)
 await screenshot('historical-review')
 await button('Return to current replay').click(); await settle()
 const live=(await geometry())[0]; visible(live); assert.equal(live.following,true)
 evidence.checks.historicalReview={review,earlier,live}
 // Save and restore a manual viewport, zoom and price scale in three independent panes.
 await page.locator('input[name="chart-count"][value="3"]').check(); await settle()
 await pan(1,.25,.4)
 const canvas=(await page.locator('.chart-canvas').nth(2).boundingBox())!
 await page.mouse.move(canvas.x+150,canvas.y+80); await page.mouse.wheel(0,-100); await settle()
 // Preserve an independently adjusted vertical scale as well as time navigation.
 const priceBox=(await page.locator('.chart-canvas').nth(2).boundingBox())!, plot=(await geometry())[2].plotWidth
 await page.mouse.move(priceBox.x+plot+12,priceBox.y+80); await page.mouse.wheel(0,100); await settle()
 const savedGeometry=await geometry(), savedStates=await states()
 assert.equal(savedStates[2].auto,false)
 await button('Sessions / settings').click()
 for(const control of await page.locator('.header-replay button, .header-replay input, .header-replay select').all()) assert.equal(await control.isDisabled(),true)
 await button('Save now').click(); await page.waitForFunction(()=>document.querySelector('.save-state')?.textContent==='Saved')
 const checkpoint=(await storage.list()).sessions[0].checkpoint
 await page.reload(); await button('Resume backtest').click(); await page.locator('.chart-canvas').first().waitFor(); await settle()
 assert.deepEqual((await observation()).trading,checkpoint.trading)
 const restored=await geometry()
 for(let id=0;id<3;id++) {
  assert.ok(Math.abs(restored[id].range.from-savedGeometry[id].range.from)<.01)
  assert.ok(Math.abs(restored[id].range.to-savedGeometry[id].range.to)<.01)
  assert.equal(restored[id].following,savedGeometry[id].following)
 }
 assert.deepEqual((await states()).map(s=>({price:s.price,auto:s.auto})),savedStates.map(s=>({price:s.price,auto:s.auto})))
 evidence.checks.restore={savedGeometry,restored}
 // Real pending/open positions and stop dragging keep the relocated controls guarded.
 const quote=(await observation()).trading.quote.trade.close
 for(const distance of [.003,.004]) {
  await button('Buy').click(); await page.getByText('Enter price with keyboard',{exact:true}).click()
  await page.getByLabel('SL price',{exact:true}).fill((quote-distance).toFixed(5)); await button('Confirm order').click()
  if(distance===.003) await button('Next Candle').click()
 }
 await settle()
 const position=(await observation()).trading.positions[0]; assert.ok(position)
 assert.equal((await observation()).trading.pending.length,1)
 for(const [width,height] of [[1440,1000],[1100,800],[1000,800]]) {
  await page.setViewportSize({width,height}); await settle()
  evidence.checks[`positions-layout-${width}`]=await layoutEvidence(); await screenshot(`positions-${width}`)
 }
 await page.setViewportSize({width:1440,height:1000}); await settle()
 const stopY=await page.evaluate(price=>(globalThis as any).__uxCharts[0].series.priceToCoordinate(price),position.stopPrice)
 const stopBox=(await page.locator('.chart-canvas').first().boundingBox())!
 assert.ok(stopY>0 && stopY<stopBox.height)
 await page.mouse.move(stopBox.x+150,stopBox.y+stopY); await page.mouse.down(); await page.mouse.move(stopBox.x+150,stopBox.y+stopY-10)
 await page.locator('.stop-drag-status').waitFor()
 for(const control of await page.locator('.header-replay button, .header-replay input, .header-replay select').all()) assert.equal(await control.isDisabled(),true)
 await screenshot('stop-drag-header-disabled')
 await page.keyboard.press('Escape'); await page.mouse.up(); await settle()
 assert.equal(await button('Play').isDisabled(),false)
 evidence.checks.stopDragGuard=true
 // Every plotted candle is in the revealed prefix, including after stepping across gaps.
 const obs=await observation()
 for(const g of restored) assert.ok(g.time*1000 <= obs.timestamp)
 // Walk the authentic cached data to its next contract boundary using real D1 shortcuts.
 await page.getByLabel('Chart 1 timeframe',{exact:true}).selectOption('D1'); await settle()
 await page.locator('.chart-canvas').first().click({position:{x:80,y:80}})
 let gap=false, days=0
 while(!(await observation()).blocked && days++<95) {
  const before=await observation()
  await page.keyboard.press('Shift+ArrowRight')
  await page.waitForFunction(count=>(globalThis as any).__keyboardObservation.replay.count>count,before.count)
  const after=await observation()
  if(after.timestamp-before.timestamp>(after.count-before.count)*60000) gap=true
  for(const g of await geometry()) assert.ok(g.time*1000<=after.timestamp)
 }
 const blocked=await observation(); assert.equal(blocked.blocked,true); assert.equal(gap,true)
 assert.equal(await button('Play').isDisabled(),true); assert.equal(await button('Next Candle').isDisabled(),true)
 await page.keyboard.press('Shift+ArrowRight'); await page.waitForTimeout(300)
 assert.deepEqual(await observation(),blocked)
 evidence.checks.rollover={timestamp:blocked.timestamp,count:blocked.count,days,observedGap:gap,geometry:await geometry()}
 await screenshot('rollover-blocked')
 assert.deepEqual(await manifest(), beforeCache); evidence.checks.cacheUnchanged=true
 assert.equal(evidence.providerRequests,0); assert.equal(evidence.paidSubmissions,0); assert.deepEqual(evidence.errors,[])
 await writeFile(`${output}/browser-evidence.json`,JSON.stringify(evidence,null,2)+'\n')
 console.log(JSON.stringify({checks:Object.keys(evidence.checks),screenshots:evidence.screenshots.length,providerRequests:evidence.providerRequests,paidSubmissions:evidence.paidSubmissions}))
} catch(error) {
 await screenshot('failure'); await writeFile(`${output}/browser-failure.json`,JSON.stringify({...evidence,failure:String(error)},null,2)); throw error
} finally {
 await browser.close(); await vite.close(); await new Promise<void>(resolve => { backend.close(() => resolve()); backend.closeAllConnections() }); await storage.close()
}
