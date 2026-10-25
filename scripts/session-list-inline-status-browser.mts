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
const directory = await mkdtemp(join(tmpdir(), 'forextester-trade-shortcuts-'))
const output = 'docs/session-list-and-inline-status-cleanup'
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
 plugins: [{ name: 'trade-shortcut-observation', transform(code, id) {
  if (id.endsWith('/App.tsx')) return code.replace('synchronizer.advance(bounds)', 'globalThis.__uxSync = synchronizer; synchronizer.advance(bounds)').replace(/const trading = useTrading\(history, replay, hydration\);?/, `const trading = useTrading(history, replay, hydration);
    globalThis.__keyboardObservation = { source, replay, trading, draft, stopPreview };`)
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
async function screenshot(name: string) { console.log(name); const path = `${output}/${name}.png`; await page.screenshot({ path }); evidence.screenshots.push(path) }
const observation = () => page.evaluate(() => { const { trading, replay } = (globalThis as any).__keyboardObservation; return { trading: trading.state, timestamp: replay.timestamp, reviewing: replay.reviewing } })
const saved = () => page.waitForFunction(() => document.querySelector('.save-state')?.textContent === 'Saved')
async function point(price: number, id = 0) {
 const box = (await page.locator('.chart-canvas').nth(id).boundingBox())!
 const y = await page.evaluate(({ price, id }) => (globalThis as any).__uxCharts[id].series.priceToCoordinate(price), { price, id })
 assert.ok(y !== null && y > 0 && y < box.height, `Price outside pane: ${y}`)
 return { x: box.x + 80, y: box.y + y }
}
const round = (value: number) => Math.round(value * 100000) / 100000
const focusChart = () => page.locator('h1').click()
async function layoutEvidence() {
 const result = await page.evaluate(() => {
  const rect = (el: Element) => { const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height} }
  const toolbar=rect(document.querySelector('.workspace-toolbar')!)
  const draft=document.querySelector('.stop-placement')
  return {viewport:innerWidth,pageWidth:document.documentElement.scrollWidth,toolbar,
   controls:Array.from(document.querySelectorAll('.dock-controls > label,.dock-controls > button,.dock-controls > span,.open-total')).map(rect),
   draft:draft?{...rect(draft),parent:draft.parentElement!.className}:null}
 })
 assert.equal(result.pageWidth,result.viewport,'No full-page overflow')
 assert.equal(result.toolbar.height,39,JSON.stringify(result))
 for (const box of [...result.controls,...(result.draft?[result.draft]:[])]) {
  assert.ok(box.y>=result.toolbar.y && box.bottom<=result.toolbar.bottom,JSON.stringify(result))
 }
 if(result.draft) assert.equal(result.draft.parent,'dock-controls')
 return result
}
async function matrix(prefix: string) {
 for(const count of [1,2,3]) {
  await page.locator(`input[name="chart-count"][value="${count}"]`).check()
  for(const [width,height] of [[1440,1000],[1100,800],[1000,800]]) {
   await page.setViewportSize({width,height});await settle()
   evidence.checks[`${prefix}-${count}-${width}`]=await layoutEvidence()
   if(count===1) await screenshot(`${prefix}-${width}`)
  }
 }
 await page.setViewportSize({width:1440,height:1000});await page.locator('input[name="chart-count"][value="1"]').check();await settle()
}
async function pnlEvidence() {
 const state=(await observation()).trading
 const nets=state.positions.map((p:any)=>(state.quote.trade.close-p.entryPrice)*(p.direction==='buy'?1:-1)*p.lots*100000-p.entryCommissionUsd-p.lots*p.commission.roundTripUsdPerLot/2)
 const net=nets.reduce((sum:number,value:number)=>sum+value,0)
 const text=`${net<0?'-':''}$${Math.abs(net).toFixed(2)} (${(net/state.account.referenceBalance*100).toFixed(2)}%)`
 assert.equal(await page.locator('.open-total strong').innerText(),text)
 return {net,text,ids:state.positions.map((p:any)=>p.id)}
}
async function draft(key: string, stop: number) {
 await focusChart();await page.keyboard.press(key);await settle()
 await page.evaluate(({stop})=>{
  const {series}=(globalThis as any).__uxCharts[0]
  const quote=(globalThis as any).__keyboardObservation.trading.state.quote.trade.close
  series.priceScale().setVisibleRange({from:Math.min(stop,quote)-.002,to:Math.max(stop,quote)+.002})
 },{stop});await settle()
 const at=await point(stop);await page.mouse.move(at.x,at.y);await settle()
 assert.match(await page.locator('.draft-stop-annotation').first().innerText(),/pips/)
 await page.mouse.click(at.x,at.y);await settle()
 assert.equal(await button('Confirm order').isEnabled(),true)
}
async function submit(key: string, stop: number) {
 await draft(key,stop);await button('Confirm order').click();await saved();await settle()
}
async function next() {await button('Next Candle').click();await saved();await settle()}
async function sessionName(name: string) {
 await button('Sessions / settings').click()
 await page.getByRole('textbox',{name:'Current session name',exact:true}).fill(name)
 await button('Save now').click();await saved()
}

try {
 await page.goto('http://127.0.0.1:5198'); await button(process.env.CAPTURE_BEFORE ? '90 days' : '30 days').click()
 await page.getByText('Advanced settings', { exact: true }).click()
 await page.getByRole('spinbutton', { name: 'Round-trip commission (USD per standard lot)', exact: true }).fill('7')
 await button('Start backtest').click(); await page.locator('.chart-canvas').first().waitFor(); await settle(); await saved()
 if (process.env.CAPTURE_BEFORE) {
  for (const [width,height] of [[1440,1000],[1100,800],[1000,800]]) {
   await page.setViewportSize({width,height}); await settle()
   await focusChart(); await page.keyboard.press('b'); await settle()
   evidence.checks[`before-${width}`] = { toolbarHeight: await page.locator('.workspace-toolbar').evaluate(el=>el.getBoundingClientRect().height) }
   await screenshot(`before-placement-${width}`); await button('Cancel placement').click()
  }
  await page.reload(); await button('Resume backtest').waitFor()
  await screenshot('before-chooser')
 } else {
  // Two sessions created through the normal cached-data workflow.
  await sessionName('Cache verification')
  await button('New session').click();await button(process.env.CAPTURE_BEFORE ? '90 days' : '30 days').click();await button('Start backtest').click()
  await page.locator('.chart-canvas').first().waitFor();await saved();await sessionName('Delete me');await button('Close management').click()
  await page.reload();await button('Resume backtest').first().waitFor()
  for(const [width,height] of [[1440,1000],[1100,800],[1000,800]]) {
   await page.setViewportSize({width,height});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width)
   await screenshot(`after-chooser-${width}`)
  }
  await page.setViewportSize({width:1440,height:1000})
  const original=(await storage.list()).sessions.find((s:any)=>s.name==='Cache verification')!
  await button('Rename backtest Cache verification').click()
  const editor=page.getByRole('textbox',{name:`Rename session ${original.id}`,exact:true})
  assert.equal(await editor.evaluate(el=>el===document.activeElement),true)
  await editor.fill('   ');assert.equal(await button('Confirm rename').isEnabled(),false)
  await editor.press('Escape');assert.equal(await button('Rename backtest Cache verification').evaluate(el=>el===document.activeElement),true)
  await button('Rename backtest Cache verification').click();await editor.fill('Discarded');await button('Cancel rename').click()
  await button('Rename backtest Cache verification').click();await editor.fill('Renamed cache verification');await screenshot('inline-rename')
  assert.equal((await storage.list()).sessions.find((s:any)=>s.id===original.id)!.name,'Cache verification')
  await editor.press('Enter');await button('Rename backtest Renamed cache verification').waitFor();await settle()
  assert.equal(await button('Rename backtest Renamed cache verification').evaluate(el=>el===document.activeElement),true)
  const renamed=(await storage.list()).sessions.find((s:any)=>s.id===original.id)!
  assert.deepEqual(renamed.checkpoint,original.checkpoint);assert.equal(renamed.historyId,original.historyId)
  evidence.checks.rename={id:renamed.id,name:renamed.name,checkpointPreserved:true,focusRestored:true}
  await button('Delete backtest Delete me').click();assert.equal(await button('Cancel delete').evaluate(el=>el===document.activeElement),true)
  await screenshot('delete-confirmation');await button('Cancel delete').click()
  assert.equal((await storage.list()).sessions.length,2)
  assert.equal(await button('Delete backtest Delete me').evaluate(el=>el===document.activeElement),true)
  await button('Delete backtest Delete me').click();await button('Confirm delete').click()
  await page.waitForFunction(()=>document.querySelectorAll('.saved-session').length===1)
  assert.equal((await storage.list()).sessions.length,1);await screenshot('after-delete')
  evidence.checks.delete={cancelPreserved:true,confirmedRemoved:true}
  await button('Resume backtest').click();await page.locator('.chart-canvas').first().waitFor();await saved();await settle()
  await matrix('empty')
  await page.getByRole('spinbutton',{name:'Risk per entry (%)',exact:true}).fill('.35')
  await focusChart();await page.keyboard.press('s');await settle();await matrix('selecting-sl')
  const region=page.getByRole('region',{name:'Place stop-loss',exact:true})
  await region.locator('summary').click()
  await page.getByRole('spinbutton',{name:'SL price',exact:true}).fill(String(round((await observation()).trading.quote.trade.close+.003)))
  await matrix('keyboard-sl');await button('Cancel placement').click()
  assert.equal(await region.count(),0)
  const market=round((await observation()).trading.quote.trade.close)
  await draft('b',round(market-.003));await matrix('selected-sl')
  await button('Confirm order').click();await saved();await next()
  await submit('b',round(market-.0035))
  const mixed=(await observation()).trading
  assert.equal(mixed.positions.length,1);assert.equal(mixed.pending.length,1)
  await button('Close all').click();await saved();await settle()
  const requested=(await observation()).trading
  assert.deepEqual(requested.pending,mixed.pending);assert.ok(requested.positions[0].closeRequestedAt!==null)
  assert.equal(await button('Close all').isEnabled(),false)
  evidence.checks.pendingUntouched=true
  await next();assert.equal((await observation()).trading.positions.length,1)
  const last=(await observation()).trading.positions[0].id
  await button(`Close ${last}`).click();await next();assert.equal((await observation()).trading.positions.length,0)
  evidence.checks.individualClose=true
  const current=round((await observation()).trading.quote.trade.close)
  await submit('b',round(current-.003));await next();await submit('b',round(current-.0035));await next()
  const beforeClose=(await observation()).trading
  assert.equal(beforeClose.positions.length,2);evidence.checks.combinedPnl=await pnlEvidence()
  await matrix('two-open');await focusChart();await screenshot('close-all-default')
  await button('Close all').hover();await screenshot('close-all-hover')
  assert.equal(await button('Close all').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(140, 48, 60)')
  await button('Close all').focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');assert.equal(await button('Close all').evaluate(el=>getComputedStyle(el).outlineStyle),'solid')
  const checkpoint=(await observation()).trading
  await saved();await page.reload();await button('Resume backtest').click();await page.locator('.chart-canvas').first().waitFor();await saved();await settle()
  assert.deepEqual((await observation()).trading,checkpoint);evidence.checks.restoreOpen=true
  await button('Close all').click();await next()
  const closed=(await observation()).trading
  assert.equal(closed.positions.length,0);assert.equal(closed.closed.length,4)
  assert.equal(await page.locator('.open-total').count(),0);assert.equal(await button('Close all').count(),0)
  const account=await page.getByLabel('Account PnL',{exact:true}).innerText()
  await page.reload();await button('Resume backtest').click();await page.locator('.chart-canvas').first().waitFor();await saved();await settle()
  assert.deepEqual((await observation()).trading,closed)
  assert.equal(await page.getByLabel('Account PnL',{exact:true}).innerText(),account)
  await screenshot('restored-after-close-all');evidence.checks.closeAll={closedIds:closed.closed.map((p:any)=>p.id),account,restore:true}
  page.once('dialog',dialog=>dialog.accept());await button('Finish backtest').click();await page.locator('.phase-finished').waitFor()
  await button('Journal').click();await page.getByLabel('Journal view',{exact:true}).selectOption('positions')
  for(const position of closed.closed) assert.match(await page.locator('.journal-table-scroll').innerText(),new RegExp(position.id))
  await screenshot('journal-after-close-all');evidence.checks.journal=true
 }
 assert.deepEqual(await manifest(),beforeCache)
 assert.equal(evidence.providerRequests,0); assert.equal(evidence.paidSubmissions,0); assert.deepEqual(evidence.errors,[])
 await writeFile(`${output}/${process.env.CAPTURE_BEFORE ? 'before' : 'browser'}-evidence.json`,JSON.stringify(evidence,null,2)+'\n')
 console.log(JSON.stringify(evidence.checks,null,2))
} catch (error) { console.error(error); await writeFile(`${output}/browser-failure.json`,JSON.stringify({...evidence,failure:String(error)},null,2)); await screenshot('failure').catch(()=>{}); throw error }
finally { await browser.close(); await vite.close(); await new Promise<void>(resolve => { backend.close(() => resolve()); backend.closeAllConnections() }); await storage.close() }
