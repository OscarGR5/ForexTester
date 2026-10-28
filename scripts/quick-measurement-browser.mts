// Real Chromium gestures against the production App and ChartPane. All history
// and session writes belong to a disposable server, never the user's archive.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'
import { createApp } from '../backend/src/app.js'
import { SessionStorage } from '../backend/src/sessionStorage.js'
import { DiskSessionStore } from '../frontend/src/diskSessionStore.js'
import { historyFingerprint } from '../frontend/src/sessionCodec.js'
import { sessionSimulation } from '../frontend/src/sessionFixtures.js'
import { defaultWorkspace, selectChartMode } from '../frontend/src/uiPreferences.js'
import { benchmarkHistory } from './chart-replay-data.js'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core')
const output = process.env.BROWSER_OUTPUT ?? 'docs/quick-measurement'
await mkdir(output, { recursive: true })
const directory = await mkdtemp(join(tmpdir(), 'forextester-measurement-'))
const storage = new SessionStorage({ directory })
// Only cached session history is used. Archive discovery returns an empty set.
const archive = { datasets: async () => ({ datasets: [] }), calendar: async () => ({ days: [] }) }
const api = createApp(archive as any, undefined, storage)
await new Promise<void>(done => api.listen(0, '127.0.0.1', done))
const apiOrigin = `http://127.0.0.1:${(api.address() as { port: number }).port}`
const nativeFetch = globalThis.fetch
const history = benchmarkHistory(3)
const tradingStart = history.bid.findIndex(c => c.timestamp >= Date.parse(history.tradingFrom))
const sim = sessionSimulation({ ...history, bid: history.bid.slice(tradingStart), ask: history.ask.slice(tradingStart) })
sim.observe(100)
const snapshot = sim.snapshot()
snapshot.checkpoint.replay.startIndex = tradingStart
snapshot.checkpoint.replay.startTimestamp = history.bid[tradingStart].timestamp
snapshot.checkpoint.replay.index! += tradingStart
snapshot.checkpoint.executionCursor += tradingStart
snapshot.checkpoint.workspace = selectChartMode(defaultWorkspace(), 1)
snapshot.checkpoint.workspace.timeframes[0] = 'H1'
snapshot.checkpoint.workspace.indicators[0].H1 = snapshot.checkpoint.workspace.indicators[2].H1!
const id = randomUUID(), otherId = randomUUID()
try {
  globalThis.fetch = ((path: string, init?: RequestInit) => nativeFetch(`${apiOrigin}${path}`, { ...init, headers: { Origin: apiOrigin, ...init?.headers } })) as typeof fetch
  const store = new DiskSessionStore(), historyId = await historyFingerprint(history)
  await store.cacheHistory(historyId, history)
  await store.save({ id, name: 'Quick measurement regression', createdAt: new Date().toISOString(), range: { from: history.tradingFrom, to: history.to }, totalCandles: history.bid.length, historyId }, snapshot, null)
  await store.save({ id: otherId, name: 'Other measurement session', createdAt: new Date().toISOString(), range: { from: history.tradingFrom, to: history.to }, totalCandles: history.bid.length, historyId }, snapshot, null)
} finally { globalThis.fetch = nativeFetch }

const vite = await createServer({ configFile: false, root: resolve('frontend'), cacheDir: join(directory, 'vite'),
  plugins: [{ name: 'test-only-chart-probe', transform(code, path) {
    if (path.endsWith('/src/useMeasurement.ts')) return code.replace('binding.current = controller', '(globalThis.__measurements ??= []).push({ controller, primitive }); binding.current = controller')
    if (path.endsWith('/src/MeasurementPrimitive.ts')) return code.replace('ctx.fillText(pipLabel,', '(globalThis.__measurementLabels ??= []).push({ primitive:this,pipLabel,spanLabel,x,y,width,height,paneWidth:size.width,paneHeight:size.height }); ctx.fillText(pipLabel,')
    if (!path.endsWith('/src/ChartPane.tsx')) return
    // Observe public chart APIs without adding any hooks to the shipped app.
    return code.replace('chartRef.current = chart', '(globalThis.__charts ??= {})[id] = { chart, series }; chartRef.current = chart')
      .replace('const unregister = synchronizer.register', '(globalThis.__charts ??= {})[id].sync = synchronizer; const unregister = synchronizer.register')
  } }], server: { host: '127.0.0.1', port: 0, hmr: false, proxy: { '/api': { target: apiOrigin } } } })
await vite.listen()
const origin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/home/admin/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome', headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors: string[] = [], external: string[] = [], reports: unknown[] = []
page.on('pageerror', e => { errors.push(e.message); console.error(e.message) })
await page.route('**/*', route => {
  if (!route.request().url().startsWith(origin)) { external.push(route.request().url()); return route.abort() }
  // Never discover or download real market data in this regression.
  if (/\/api\/history\//.test(route.request().url())) return route.fulfill({ json: { datasets: [], days: [] } })
  return route.continue()
})
const settle = () => page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => done())))))
const read = (pane = 0) => page.evaluate(id => {
  const { chart, series, sync } = (globalThis as any).__charts[id]
  const scale = chart.timeScale(), range = scale.getVisibleLogicalRange(), data = series.data()
  const visible = data.filter((c: any, i: number) => i >= range.from && i <= range.to && series.priceToCoordinate(c.close) >= 0 && series.priceToCoordinate(c.close) <= chart.panes()[0].getHeight())
  return { range, span: range.to - range.from, barSpacing: scale.options().barSpacing, plotWidth: scale.width(), timeHeight: scale.height(), height: chart.panes()[0].getHeight(),
    last: data.length - 1, lastX: scale.timeToCoordinate(data.at(-1).time), lastY: series.priceToCoordinate(data.at(-1).close), visible: visible.length,
    price: series.priceScale().getVisibleRange(), autoScale: series.priceScale().options().autoScale, view: sync.snapshot().charts[id] }
}, pane)
const shot = (name: string) => page.screenshot({ path: `${output}/${name}.png`, fullPage: true })
const switchTo = async (tf: string, pane = 0) => { await page.getByLabel(`Chart ${pane + 1} timeframe`, { exact: true }).selectOption(tf); await settle() }
const drag = async (axis: 'time' | 'price' | 'plot', dx: number, dy = 0, pane = 0) => {
  const box = (await page.locator('.chart-canvas').nth(pane).boundingBox())!, state = await read(pane)
  const x = box.x + (axis === 'price' ? state.plotWidth + 25 : state.plotWidth * (axis === 'plot' ? 0.2 : 0.65))
  const y = box.y + (axis === 'time' ? box.height - state.timeHeight / 2 : state.height * 0.45)
  await page.mouse.move(x, y); await page.mouse.down()
  await page.mouse.move(x + dx, y + dy, { steps: 20 }); await page.mouse.up(); await settle()
}
const wheel = async (axis: 'time' | 'price' | 'plot', delta: number, pane = 0) => {
  const box = (await page.locator('.chart-canvas').nth(pane).boundingBox())!, state = await read(pane)
  await page.mouse.move(box.x + (axis === 'price' ? state.plotWidth + 25 : state.plotWidth * 0.65),
    box.y + (axis === 'time' ? box.height - state.timeHeight / 2 : state.height * 0.45))
  await page.mouse.wheel(0, delta); await settle()
}
const close = (a: number, b: number, label = 'range') => assert(Math.abs(a - b) < (label.includes('price') ? 1e-9 : 0.1), `${label}: ${a} != ${b}`)
const visible = (s: Awaited<ReturnType<typeof read>>) => {
  assert(s.visible > 0, 'candles must be visible')
  assert(s.lastX > 0 && s.lastX < s.plotWidth, 'replay candle must stay inside plot')
  assert(s.lastY > 0 && s.lastY < s.height, 'autoscaled replay candle must be visible vertically')
}
const resetFollow = async (pane = 0, width = 100) => {
  await page.evaluate(({ pane, width }) => {
    const { chart, series, sync } = (globalThis as any).__charts[pane]
    series.priceScale().applyOptions({ autoScale: true })
    const data = series.data(), last = chart.timeScale().timeToIndex(data.at(-1).time)
    sync.activate(pane); chart.timeScale().setVisibleLogicalRange({ from: last + 26 - width, to: last + 26 })
  }, { pane, width }); await settle()
}
const measurement = (pane = 0) => page.evaluate(id => {
  const { series } = (globalThis as any).__charts[id]
  const item = (globalThis as any).__measurements.findLast((v: any) => v.primitive.series === series)
  const value = item?.primitive.value
  if (!value) return null
  const { start, end } = value, pips = (end.price - start.price)/.0001
  return { ...value, pips, bars: Math.abs(end.index-start.index), seconds: Math.abs(end.time-start.time) }
}, pane)
const label = (pane = 0) => page.evaluate(id => {
  const item = (globalThis as any).__measurements.findLast((v: any) => v.primitive.series === (globalThis as any).__charts[id].series)
  const row = (globalThis as any).__measurementLabels?.findLast((v: any) => v.primitive === item.primitive)
  if (!row) return null
  const { primitive, ...result } = row
  return result
}, pane)
const readable = async (pane = 0) => {
  const row = await label(pane)
  assert(row, 'primitive rendered label')
  assert(row.x >= 4 && row.y >= 4 && row.x + row.width <= row.paneWidth - 4 && row.y + row.height <= row.paneHeight - 4, 'label stays in candle plot')
  assert.match(row.pipLabel, /^[+-]?\d+\.\d pips$/)
  assert.match(row.spanLabel, /^\d+ bars · [\ddhm ]+$/)
  return row
}
const points = async (pane = 0) => {
  await resetFollow(pane, 60)
  const box = (await page.locator('.chart-canvas').nth(pane).boundingBox())!, state = await read(pane)
  const coords = await page.evaluate(id => {
    const { chart, series } = (globalThis as any).__charts[id], data = series.data()
    const first = Math.max(0,data.length-28), last = data.length-4
    return { x1: chart.timeScale().timeToCoordinate(data[first].time), x2: chart.timeScale().timeToCoordinate(data[last].time),
      first, last, time1:data[first].time, time2:data[last].time }
  },pane)
  return { ...coords, x1:box.x+coords.x1,x2:box.x+coords.x2,y1:box.y+state.height*.55,y2:box.y+state.height*.35,box,state }
}
const measure = async (pane = 0, style = 'drag', positive = true) => {
  const p = await points(pane), y2 = positive ? p.y2 : p.box.y+p.state.height*.75
  const before = await read(pane)
  await page.keyboard.down('Shift'); await page.mouse.move(p.x1,p.y1); await page.mouse.down()
  if(style === 'click') { await page.mouse.up(); await page.keyboard.up('Shift') }
  await page.mouse.move(p.x2,y2,{steps:12})
  if(style === 'click') await page.mouse.down()
  await page.mouse.up(); await page.keyboard.up('Shift'); await settle()
  const m = await measurement(pane), after=await read(pane)
  assert(m,`measurement missing: ${pane}/${style}`); assert.equal(m.start.index,p.first); assert.equal(m.end.index,p.last)
  assert.equal(m.bars,p.last-p.first); assert.equal(m.seconds,p.time2-p.time1)
  assert(positive ? m.pips>0 : m.pips<0)
  close(before.range.from,after.range.from,'measurement leaves viewport from'); close(before.range.to,after.range.to,'measurement leaves viewport to')
  return {pane,style,positive,m,label:await readable(pane)}
}
try {
  await page.goto(origin)
  await page.locator('.saved-session').filter({ has: page.getByRole('button', { name: 'Rename backtest Quick measurement regression', exact: true }) }).getByRole('button', { name: 'Resume backtest', exact: true }).click()
  await page.locator('.phase-trading').waitFor(); await settle()
  // An awaiting ruler cancels before an external pointerdown reaches its target.
  await page.locator('input[name="chart-count"][value="2"]').check(); await switchTo('H1')
  const pending = async () => {
    const p=await points()
    await page.keyboard.down('Shift'); await page.mouse.click(p.x1,p.y1); await page.keyboard.up('Shift')
    await page.mouse.move(p.x2,p.y2); await settle(); assert(await measurement())
  }
  await pending()
  const otherBox=(await page.locator('.chart-canvas').nth(1).boundingBox())!
  await page.mouse.click(otherBox.x+80,otherBox.y+80); await settle()
  assert.equal(await measurement(),null,'another chart click cancels the pending ruler')
  assert.equal(await page.locator('.chart-pane').nth(1).getAttribute('data-active'),'true','the same click activates the other chart')
  await pending()
  await page.getByRole('button',{name:'Buy',exact:true}).click(); await settle()
  assert.equal(await measurement(),null,'order-control click cancels the pending ruler')
  assert.equal(await page.getByRole('region',{name:'Place stop-loss',exact:true}).isVisible(),true,'the same click opens order placement')
  await page.getByRole('button',{name:'Cancel placement',exact:true}).click()
  reports.push({check:'awaiting ruler yields the same click to another chart and an order control'})
  for(const count of (process.env.SKIP_LAYOUTS ? [] : [1,2,3])) {
    await page.locator(`input[name="chart-count"][value="${count}"]`).check(); await settle()
    for(let pane=0;pane<count;pane++) {
      for(const tf of ['H1','M5','D1']) {
        await switchTo(tf,pane)
        reports.push({count,tf,...await measure(pane,'drag',true)})
        if(count===1 || count===3 && pane===2 && tf==='D1') await shot(`green-${count}-${pane}-${tf}`)
        reports.push({count,tf,...await measure(pane,'click',false)})
        if(count===1 || count===3 && pane===2 && tf==='D1') await shot(`red-${count}-${pane}-${tf}`)
        // Coordinate conversion stays anchored after horizontal and vertical zoom.
        const anchored=await measurement(pane)
        await wheel('plot',-70,pane); await wheel('price',-50,pane)
        assert.deepEqual(await measurement(pane),anchored)
        await page.keyboard.press('Escape'); assert.equal(await measurement(pane),null)
        // Native pan and both zoom paths work after completion and Escape.
        const before=await read(pane); await drag('plot',60,0,pane); const after=await read(pane)
        assert(Math.abs(before.range.from-after.range.from)>.1,'native pan restored')
        await switchTo(tf==='H1'?'M5':'H1',pane); assert.equal(await measurement(pane),null)
      }
      await switchTo('H1',pane); const p=await points(pane)
      await page.keyboard.down('Shift'); await page.mouse.move(p.x1,p.y1); await page.mouse.down()
      await page.mouse.move(p.box.x+p.box.width+80,p.box.y+p.box.height+40,{steps:15})
      await page.mouse.up(); await page.keyboard.up('Shift'); await settle()
      const cross=await measurement(pane); assert(cross); assert.equal(cross.end.index,(await read(pane)).last)
      for(let other=0;other<count;other++) if(other!==pane) assert.equal(await measurement(other),null)
      reports.push({count,pane,check:'cross-boundary drag',cross})
      // Start another measurement, then cancel during pointer capture.
      await page.keyboard.down('Shift'); await page.mouse.move(p.x1,p.y1); await page.mouse.down()
      await page.keyboard.press('Escape'); await page.mouse.up(); await page.keyboard.up('Shift')
      assert.equal(await measurement(pane),null)
    }
    await measure(0)
    const next=count===3?1:count+1
    await page.locator(`input[name="chart-count"][value="${next}"]`).check(); await settle()
    assert.equal(await measurement(0),null,'layout change clears retained chart')
  }
  await page.locator('input[name="chart-count"][value="1"]').check(); await switchTo('H1')
  await measure(); let p=await points()
  await page.mouse.click(p.x1,p.y1); assert.equal(await measurement(),null,'ordinary click clears')
  // Shift cannot select a draft or confirm an order. Normal placement still works.
  await page.getByRole('button',{name:'Buy',exact:true}).click()
  const status=page.getByLabel('Placement status',{exact:true}), statusBefore=await status.innerText()
  await page.keyboard.down('Shift'); await page.mouse.click(p.x1,p.y1); await page.keyboard.up('Shift'); await settle()
  assert.equal(await measurement(),null); assert.equal(await status.innerText(),statusBefore)
  assert.equal(await page.getByRole('button',{name:'Confirm order',exact:true}).isDisabled(),true)
  // Lightweight Charts groups native clicks within 500 ms as a double-click.
  await page.waitForTimeout(550)
  await page.mouse.click(p.x1,p.box.y+p.state.height*.8); await settle()
  assert.equal(await page.getByRole('button',{name:'Confirm order',exact:true}).isEnabled(),true)
  await page.getByRole('button',{name:'Confirm order',exact:true}).click()
  assert.equal(await page.locator('[data-order-id]').count(),1)
  await page.getByRole('button',{name:'Next Min',exact:true}).click(); await settle()
  assert.equal(await page.locator('[data-position-id]').count(),1)
  // Stop dragging is unmodified and applies exactly once. Read stop via durable state.
  await page.getByRole('button',{name:'Sessions / settings',exact:true}).click()
  await page.getByRole('button',{name:'Save now',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('.save-state')?.textContent==='Saved')
  await page.keyboard.press('Escape'); await settle()
  const beforeStop=(await storage.list()).sessions.find(session=>session.id===id)!.checkpoint.trading.positions[0]
  const stopY=await page.evaluate(price=>(globalThis as any).__charts[0].series.priceToCoordinate(price),beforeStop.stopPrice)
  p=await points(); const beforeCount=beforeStop.stopModifications.length
  await page.mouse.move(p.box.x+60,p.box.y+stopY); await page.mouse.down()
  await page.mouse.move(p.box.x+60,p.box.y+stopY-8,{steps:10}); await page.mouse.up(); await settle()
  await page.getByRole('button',{name:'Sessions / settings',exact:true}).click()
  await page.getByRole('button',{name:'Save now',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('.save-state')?.textContent==='Saved')
  await page.keyboard.press('Escape')
  const afterStop=(await storage.list()).sessions.find(session=>session.id===id)!.checkpoint.trading.positions[0]
  assert.equal(afterStop.stopModifications.length,beforeCount+1,'stop drag still commits once')
  reports.push({check:'placement priority and stop drag',beforeStop,afterStop})
  // Measurement handling leaves both existing replay shortcut variants intact.
  await measure(); const progress=()=>page.locator('[aria-label="Replay progress"]').textContent()
  const initial=await progress(); await page.keyboard.press('Control+Shift+ArrowRight'); await settle(); assert.notEqual(await progress(),initial)
  const oneMinute=await progress(); await page.keyboard.press('Shift+ArrowRight'); await settle(); assert.notEqual(await progress(),oneMinute)
  await page.keyboard.press('Shift+ArrowLeft'); await settle(); await page.locator('.history-review').waitFor()
  await page.keyboard.press('Control+Shift+ArrowLeft'); await settle()
  await page.getByRole('button',{name:'Return to current replay',exact:true}).click(); await settle()
  reports.push({check:'Shift and Ctrl+Shift replay shortcuts',initial,oneMinute,final:await progress()})
  // Tiny neutral and plot-edge measurements keep the two-line label readable.
  p=await points()
  for(const [name,x,y] of [['tiny-neutral',p.x2,p.y1],['top-right',p.box.x+p.state.plotWidth-2,p.box.y+2],['bottom-left',p.box.x+2,p.box.y+p.state.height-2]] as const) {
    await page.keyboard.down('Shift'); await page.mouse.move(x,y); await page.mouse.down(); await page.mouse.up(); await page.keyboard.up('Shift')
    await page.mouse.click(x,y); await settle()
    const m=await measurement(); assert(m); assert.equal(m.bars,0); assert.equal(m.pips,0)
    reports.push({check:name,m,label:await readable()}); await shot(name); await page.keyboard.press('Escape')
  }
  // Cancellation during drag releases pointer capture and restores navigation.
  for(const reason of ['blur','pointercancel']) {
    p=await points(); await page.keyboard.down('Shift'); await page.mouse.move(p.x1,p.y1); await page.mouse.down()
    await page.evaluate(reason=> reason==='blur' ? window.dispatchEvent(new Event('blur')) : document.querySelector('.chart-canvas')!.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerId:1})),reason)
    await page.mouse.up(); await page.keyboard.up('Shift'); assert.equal(await measurement(),null)
  }
  // Reload/session lifecycle never persists a measurement.
  await measure(); await page.reload(); await page.locator('.saved-session').filter({ has: page.getByRole('button', { name: 'Rename backtest Quick measurement regression', exact: true }) }).getByRole('button', { name: 'Resume backtest', exact: true }).click()
  await page.locator('.phase-trading').waitFor(); await settle(); assert.equal(await measurement(),null)
  await measure()
  await page.getByRole('button',{name:'Sessions / settings',exact:true}).click()
  await page.getByRole('button',{name:'Resume / Manage sessions',exact:true}).click()
  await page.locator('.saved-session').filter({has:page.getByRole('button',{name:'Rename backtest Other measurement session',exact:true})}).getByRole('button',{name:'Resume session',exact:true}).click()
  await page.waitForFunction(()=>document.body.textContent?.includes('Other measurement session') && !(globalThis as any).__measurements.findLast((v:any)=>v.primitive.series===(globalThis as any).__charts[0].series)?.primitive.value)
  await page.keyboard.press('Escape'); await settle(); assert.equal(await measurement(),null)
  reports.push({check:'reload and session switch clear overlays'})
  assert.deepEqual(errors,[]); assert.deepEqual(external,[])
  await writeFile(`${output}/browser-evidence.json`,JSON.stringify({reports,errors,external},null,2)+'\n')
  console.log(`Verified ${reports.length} measurement scenarios; no page errors or external requests`)
} catch(error) { await shot('failure'); throw error }
finally {
  await browser.close(); await vite.close()
  await new Promise<void>(done=>{api.close(()=>done());api.closeAllConnections()})
  await storage.close(); await rm(directory,{recursive:true,force:true})
}
