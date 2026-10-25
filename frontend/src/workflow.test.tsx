// @vitest-environment jsdom
import { diskApiFixture } from '../../tests/diskApiFixture'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { webcrypto } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createChart, type CandlestickData, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts'
import { App } from './App'
import * as persistence from './useSessionPersistence'
import { selectedRange, shiftDate, accountPnl } from './workflow'
import { PreferenceTabGuard } from './uiPreferenceCleanup'
import { uiKey } from './uiPreferences'
import { SessionStore } from './sessionStore'
import { DiskSessionStore } from './diskSessionStore'
import { recordDigest, historyFingerprint } from './sessionCodec'
import { sessionHistory, sessionSimulation } from './sessionFixtures'
import { createEquityLedger } from './equity'
import { lifecycleOf } from './sessionTypes'
vi.mock('lightweight-charts', () => ({
  CrosshairMode: { Normal: 0 }, CandlestickSeries: {}, LineSeries: {}, LineStyle: { Solid: 0, Dashed: 2, Dotted: 1 }, ColorType: { Solid: 'solid' },
  createChart: vi.fn(() => {
    let range = { from: 0, to: 2 }
    const scale = { getVisibleLogicalRange: () => range, width: () => 800, fitContent: vi.fn(),
      setVisibleLogicalRange: (next: typeof range) => { range = next },
      subscribeVisibleLogicalRangeChange: vi.fn(), unsubscribeVisibleLogicalRangeChange: vi.fn() }
    const makeSeries = () => {
    let values: CandlestickData<UTCTimestamp>[] = []
    let autoScale = true, priceRange = { from: 1.09, to: 1.11 }
    const priceScale = { applyOptions: vi.fn((next: { autoScale?: boolean }) => { if (typeof next.autoScale === 'boolean') autoScale = next.autoScale }), options: () => ({ autoScale }), getVisibleRange: () => priceRange, setVisibleRange: vi.fn((next: typeof priceRange) => { priceRange = next }) }
    return {
      setSeriesOrder: vi.fn(), applyOptions: vi.fn(), setData: vi.fn((next: typeof values) => { values = next.map((candle) => ({ ...candle })) }),
      update: vi.fn((candle: typeof values[number], historical = false) => {
        if (historical) {
          const index = values.findIndex((value) => value.time === candle.time)
          if (index < 0) throw new Error('Historical time missing')
          values[index] = { ...candle }; return
        }
        const last = values.at(-1)
        if (last && candle.time < last.time) throw new Error('Out-of-order chart update')
        if (last?.time === candle.time) values[values.length - 1] = { ...candle }
        else values.push({ ...candle })
      }),
      data: () => values,
      attachPrimitive: vi.fn(), detachPrimitive: vi.fn(), createPriceLine: vi.fn((options) => ({ applyOptions: vi.fn(next => Object.assign(options, next)), options: () => options })), removePriceLine: vi.fn(),
      priceScale: () => priceScale, coordinateToPrice: (y: number) => y / 100000, priceToCoordinate: (price: number) => price * 100000,
    }
    }
    return {
      applyOptions: vi.fn(), subscribeClick: vi.fn(), unsubscribeClick: vi.fn(), addSeries: vi.fn(makeSeries), removeSeries: vi.fn(), remove: vi.fn(),
      panes: () => [{ getHeight: () => 500, setStretchFactor: vi.fn() }, { getHeight: () => 100, setStretchFactor: vi.fn() }],
      timeScale: () => scale,
      subscribeCrosshairMove: vi.fn(), unsubscribeCrosshairMove: vi.fn(),
      setCrosshairPosition: vi.fn(), clearCrosshairPosition: vi.fn(),
    }
  }),
}))
const coverage={symbol:'6E',resolution:'M1',providerEarliestTimestamp:'2010-06-06T00:00:00.000Z',earliestSelectableDate:'2010-07-06',latestEligibleDate:'2024-02-29',latestBoundaryProvisional:false,lastVerifiedAvailableDate:null,providerHealth:{status:'metadata-verified'}}
let host:HTMLDivElement,root:Root,disk:Awaited<ReturnType<typeof diskApiFixture>>,historyCalls=0
let missingAsk=false,failHistory=false
const beginning=Date.UTC(2024,0,9)
const preroll=Array.from({length:90},(_,i)=>({timestamp:beginning-(90-i)*14400000,open:1.1,high:1.1002,low:1.0999,close:1.1001}))
const bid=Array.from({length:12},(_,i)=>({timestamp:beginning+i*60000,open:1.1+i*.0001,close:1.1001+i*.0001,high:1.1002+i*.0001,low:i===5?1.0985:1.0999+i*.0001}))
beforeEach(async()=>{
 disk=await diskApiFixture();historyCalls=0;missingAsk=false;failHistory=false
 window.localStorage.clear();vi.stubGlobal('indexedDB',new IDBFactory());vi.stubGlobal('IDBKeyRange',IDBKeyRange);vi.stubGlobal('crypto',webcrypto)
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});vi.spyOn(window,'confirm').mockReturnValue(true);vi.clearAllMocks()
 vi.stubGlobal('fetch',async(path:string,options?:RequestInit)=>{
  if(path.startsWith('/api/storage'))return disk.fetch(path,options)
  if(path==='/api/history/calendar')return new Response(JSON.stringify({days:[]}))
  if(path==='/api/history/coverage')return new Response(JSON.stringify(coverage))
  if(path.startsWith('/api/history/estimate')&&!failHistory) {const params=new URL(path,'http://local').searchParams;return new Response(JSON.stringify({id:'fixture-cached-quote',from:'2023-12-10',tradingFrom:params.get('from'),to:params.get('to'),cached:true,estimatedUsd:0,reservedUsd:0,remainingBudgetUsd:5,downloadAllowed:true,blockedReason:null,expiresAt:'2030-01-01T00:00:00Z',missingRanges:[]}))}
  historyCalls++;if(failHistory)return new Response(JSON.stringify({code:'DATABENTO_AUTH',error:"Databento credentials were rejected.",action:'Check backend configuration.'}),{status:502})
  const params=new URL(path,'http://local').searchParams,from=params.get('from')!,to=params.get('to')!
  return new Response(JSON.stringify({symbol:'EURUSD',resolution:'M1',from,to,bid:[...preroll,...bid].filter(b=>b.timestamp>=Date.parse(from)&&b.timestamp<Date.parse(to)),ask:[...preroll,...bid].filter(b=>b.timestamp>=Date.parse(from)&&b.timestamp<Date.parse(to)&&(!missingAsk||b.timestamp!==beginning+3*60000)).map(b=>({...b,open:b.open+.0002,close:b.close+.0002,high:b.high+.0002,low:b.low+.0002}))}))
 })
 host=document.createElement('div');document.body.append(host);root=createRoot(host)
})
afterEach(async()=>{await act(async()=>root.unmount());host.remove();await disk.close();vi.restoreAllMocks();vi.unstubAllGlobals()})
async function until(check:()=>unknown){for(let i=0;i<400;i++){if(check())return;await act(async()=>{await delay(3)})}throw Error(host.textContent!)}
async function mount(){await act(async()=>root.render(<StrictMode><App/></StrictMode>));await until(()=>!host.querySelector<HTMLFieldSetElement>('.workspace-controls')?.disabled||host.querySelector('.saved-session'))}
function button(name:string){const result=[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===name||b.getAttribute('aria-label')===name);if(!result)throw Error(`Missing ${name}: ${host.textContent}`);return result}
async function click(name:string){await act(async()=>button(name).click())}
async function input(label:string,value:string){const el=host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;expect(el).toBeTruthy();await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}))})}
async function select(label:string,value:string){const el=host.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!;await act(async()=>{el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}))})}
async function load(){await click('Start backtest');await until(()=>host.querySelector('.phase-trading'))}
async function start(){await mount();await load()}
function chart(){return vi.mocked(createChart).mock.results.filter(r=>r.type==='return').at(-1)!.value}
function chartForCanvas(canvas: Element) {
 const index = vi.mocked(createChart).mock.calls.map(([element]) => element).lastIndexOf(canvas as HTMLElement)
 return vi.mocked(createChart).mock.results[index].value
}
function canvasWheel(canvas: Element, x: number, deltaY: number, deltaMode = 0, y = 200) {
 const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: x, clientY: y, deltaY, deltaMode })
 canvas.dispatchEvent(event)
 return event
}
it.each([1, 2, 3])('scales only the hovered price axis in a %s-chart layout and retains plot wheel zoom', async count => {
 await start()
 await act(async () => host.querySelector<HTMLInputElement>(`input[name="chart-count"][value="${count}"]`)!.click())
 const canvases = [...host.querySelectorAll('.chart-canvas')]
 const charts = canvases.map(chartForCanvas)
 for (const canvas of canvases) vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 900, height: 650 } as DOMRect)
 const scales = charts.map(c => vi.mocked(c.addSeries).mock.results[0].value.priceScale())
 const originalPrices = scales.map(s => ({ ...s.getVisibleRange() }))
 const originalTimes = charts.map(c => ({ ...c.timeScale().getVisibleLogicalRange() }))
 const originalData = charts.map(c => vi.mocked(c.addSeries).mock.results[0].value.data())
 const target = count - 1, before = originalPrices[target]
 expect(canvasWheel(canvases[target], 850, -80).defaultPrevented).toBe(true)
 const expanded = scales[target].getVisibleRange()
 expect(expanded.to - expanded.from).toBeLessThan(before.to - before.from)
 expect((expanded.to + expanded.from) / 2).toBeCloseTo((before.to + before.from) / 2, 12)
 expect(scales[target].options().autoScale).toBe(false)
 canvasWheel(canvases[target], 850, 80)
 expect(scales[target].getVisibleRange().from).toBeCloseTo(before.from, 12)
 expect(scales[target].getVisibleRange().to).toBeCloseTo(before.to, 12)
 for (let i = 0; i < count; i++) {
  expect(charts[i].timeScale().getVisibleLogicalRange()).toEqual(originalTimes[i])
  expect(vi.mocked(charts[i].addSeries).mock.results[0].value.data()).toEqual(originalData[i])
  if (i !== target) {
   expect(scales[i].getVisibleRange()).toEqual(originalPrices[i])
   expect(scales[i].options().autoScale).toBe(true)
  }
 }
 canvasWheel(canvases[target], 200, -80)
 const zoom = charts[target].timeScale().getVisibleLogicalRange()!
 expect(zoom.to).toBeCloseTo(originalTimes[target].to!, 10)
 expect(zoom.from).toBeGreaterThan(originalTimes[target].from!)
 for (let i = 0; i < count; i++) if (i !== target) expect(charts[i].timeScale().getVisibleLogicalRange()).toEqual(originalTimes[i])
 expect(scales[target].getVisibleRange()).toEqual(before)
})
it('normalizes axis wheel units, bounds large deltas and ignores non-price zones and draft stops', async () => {
 await start()
 const canvas = host.querySelector('.chart-canvas')!, active = chartForCanvas(canvas)
 vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 900, height: 650 } as DOMRect)
 const scale = vi.mocked(active.addSeries).mock.results[0].value.priceScale(), before = { ...scale.getVisibleRange() }
 canvasWheel(canvas, 850, -1, 1)
 const lines = scale.getVisibleRange()
 scale.setVisibleRange(before); canvasWheel(canvas, 850, -16)
 expect(scale.getVisibleRange()).toEqual(lines)
 scale.setVisibleRange(before); canvasWheel(canvas, 850, 1, 2)
 const pages = scale.getVisibleRange()
 scale.setVisibleRange(before); canvasWheel(canvas, 850, 10000)
 expect(scale.getVisibleRange()).toEqual(pages)
 canvasWheel(canvas, 850, 0)
 expect(scale.getVisibleRange()).toEqual(pages)
 for (const [x, y] of [[850, 550], [850, 620], [910, 200], [-1, 200], [850, -1]]) canvasWheel(canvas, x, -80, 0, y)
 expect(scale.getVisibleRange()).toEqual(pages)
 await click('Buy'); canvasWheel(canvas, 850, -80)
 expect(scale.getVisibleRange()).toEqual(pages)
})
async function pick(price:number,paneIndex=0){const calls=vi.mocked(chart().subscribeClick).mock.calls;expect(calls.length).toBeGreaterThan(0);await act(async()=>calls.at(-1)![0]({point:{x:100,y:price*100000},paneIndex,seriesData:new Map()} as any))}
async function order(direction='Buy',price=.099+1){await click(direction);await pick(price);await click('Confirm order')}
it('keeps initial setup explicit, bounded and free from automatic downloads under StrictMode',async()=>{
 await mount();expect(historyCalls).toBe(0);expect(host.textContent).toContain('Set up a backtest');expect(host.querySelector('.chart-canvas')).toBeNull()
 const from=host.querySelector<HTMLInputElement>('[aria-label="From"]')!,through=host.querySelector<HTMLInputElement>('[aria-label="Through"]')!
 expect(from.min).toBe('');expect(through.max).toBe('');expect(through.value).toBe('2024-01-09')
 expect(button('90 days').disabled).toBe(true);expect(historyCalls).toBe(0)
 await input('From','2000-01-01');await click('Start backtest');expect(historyCalls).toBe(0)
})
it('keeps legacy-only recovery optional on refresh and preserves the browser original',async()=>{
 const legacy=new SessionStore(),history=sessionHistory(),sim=sessionSimulation(history),historyId=await historyFingerprint(history)
 await legacy.cacheHistory(historyId,history)
 const original=await legacy.save({id:crypto.randomUUID(),name:'Older browser backtest',createdAt:new Date().toISOString(),range:{from:history.tradingFrom,to:history.to},historyId,totalCandles:history.bid.length},sim.snapshot(),null)
 const underlying=globalThis.fetch;let release!:()=>void
 const discovery=new Promise<void>(resolve=>{release=resolve})
 vi.stubGlobal('fetch',async(path:string,options?:RequestInit)=>{if(path==='/api/storage/status')await discovery;return underlying(path,options)})
 await act(async()=>root.render(<StrictMode><App/></StrictMode>))
 expect(host.textContent).toContain('Checking saved backtests')
 expect(host.querySelector<HTMLFieldSetElement>('.workspace-controls')!.hidden).toBe(true)
 expect(host.querySelector('dialog')).toBeNull()
 await act(async()=>{release()});await until(()=>!host.querySelector<HTMLFieldSetElement>('.workspace-controls')!.disabled)
 expect(host.querySelector<HTMLFieldSetElement>('.workspace-controls')!.hidden).toBe(false)
 expect(host.querySelector('dialog')).toBeNull();expect(historyCalls).toBe(0)
 expect(button('Start backtest').disabled).toBe(false)
 await until(()=>host.textContent?.includes('Review browser backtests'));await click('Review browser backtests');expect(host.textContent).toContain('Older browser backtest')
 await click('Close management');expect(host.querySelector('dialog')).toBeNull()
 await act(async()=>root.unmount());root=createRoot(host);await mount()
 expect(host.querySelector('dialog')).toBeNull();expect(historyCalls).toBe(0)
 expect((await legacy.get(original.id)).digest).toBe(original.digest)
 expect((await disk.storage.list()).sessions).toHaveLength(0)
 await until(()=>host.textContent?.includes('Review browser backtests'));await click('Review browser backtests');await click('Import to disk');await until(()=>!button('Resume / Manage sessions').disabled)
 await click('Resume / Manage sessions');await until(()=>host.querySelector('.saved-session'))
 expect((await disk.storage.list()).sessions).toHaveLength(1)
 expect((await legacy.get(original.id)).digest).toBe(original.digest)
 await legacy.close()
})
it('saves loaded setup, locks configured account at start, and mounts chart-first trading without analytics',async()=>{
 await mount();await input('Starting balance (USD)','15000');await input('Round-trip commission (USD per standard lot)','7');await load()
 await until(()=>host.querySelector('.save-state')?.textContent==='Saved');let records=await disk.storage.list();expect(records.sessions[0].checkpoint.lifecycle).toBe('trading')
 expect(host.querySelector('.chart-canvas')).toBeTruthy();expect(host.querySelector('[aria-label="Starting balance (USD)"]')).toBeNull()
 expect(host.querySelector('.trading-journal')).toBeNull();expect(host.querySelector('[aria-label="Account PnL"]')?.textContent).toContain('$0.00 · 0.00%')
 await until(()=>host.querySelector('.save-state')?.textContent==='Saved');records=await disk.storage.list();expect(records.sessions[0].checkpoint.trading.account.referenceBalance).toBe(15000)
})
it('keeps Databento configuration errors readable and retries only on user action',async()=>{
 failHistory=true;await mount();await click('Start backtest');await until(()=>host.querySelector('.form-error[role=alert]'))
 expect(host.textContent).toContain('Databento credentials were rejected');expect(host.querySelector('.chart-message')).toBeNull()
 failHistory=false;await click('Start backtest');await until(()=>host.querySelector('.phase-trading'))
})
it.each([
 ['DATABENTO_ACCESS','Databento access denied','Databento denied dataset access.',undefined],
 ['DATABENTO_HTTP','Databento temporarily unavailable','Databento returned HTTP 429.',12000],
 ['DATABENTO_NETWORK','Databento connection failed','Databento request failed.',undefined],
])('shows an actionable %s error without a partial trading dataset',async(code,title,error,retryAfterMs)=>{
 const underlying=globalThis.fetch
 vi.stubGlobal('fetch',async(path:string,options?:RequestInit)=>path.startsWith('/api/history?')
  ? new Response(JSON.stringify({code,title,error,action:'Retry later. Completed chunks remain cached where valid.',retryAfterMs}),{status:code==='PROVIDER_RATE_LIMIT'?429:502})
  : underlying(path,options))
 await mount();await click('Start backtest');await until(()=>host.querySelector('.form-error[role=alert]'))
 expect(host.querySelector('.form-error[role=alert]')?.textContent).toContain(error)
 expect(host.querySelector('.form-error[role=alert]')?.textContent).not.toContain('install-browser')
 expect(host.querySelector('.data-ready')).toBeNull();expect(button('Start backtest').disabled).toBe(false)
 if(retryAfterMs!==undefined)expect(host.textContent).toContain(error)
})
it.each(['Buy','Sell'])('requires chart selection and confirmation for %s; rejects wrong side and ignores oscillator clicks',async(direction)=>{
 await start();await click(direction);await pick(direction==='Buy'?1.102:1.098,1);expect(button('Confirm order').disabled).toBe(true)
 await pick(direction==='Buy'?1.102:1.098);expect(button('Confirm order').disabled).toBe(true)
 expect(host.textContent).not.toContain('Choose another level');await input('SL price',direction==='Buy'?'1.099':'1.103')
 expect(host.querySelectorAll('[data-order-id]').length).toBe(0);expect(button('Confirm order').disabled).toBe(false)
 await click('Confirm order');expect(host.querySelectorAll('[data-order-id]').length).toBe(1);expect(host.querySelectorAll('[data-position-id]').length).toBe(0)
 await click('Next Candle');expect(host.querySelectorAll('[data-position-id]').length).toBe(1)
})
it('cancels drafts on Escape, play, restart and session switch without submitting orders',async()=>{
 await start();await click('Buy');await pick(1.099);await act(async()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})));expect(host.querySelector('.stop-placement')).toBeNull()
 await click('Buy');await click('Play');expect(host.querySelector('.stop-placement')).toBeNull();expect(button('Buy').disabled).toBe(true);await click('Pause')
 await click('Buy');await click('Sessions / settings');await click('Restart backtest');expect(host.querySelector('.stop-placement')).toBeNull()
 await click('Buy');await click('Sessions / settings');await click('New session');await until(()=>host.querySelector('[aria-label="Backtest setup"]'));expect(host.querySelector('.stop-placement')).toBeNull()
})
it('maintains independent stops and setup grouping, changes stop history, executes one stop and one manual close',async()=>{
 await start();await order('Buy',1.099);await click('Next Candle')
 const first=host.querySelector('[data-position-id]')!.getAttribute('data-position-id')!
 expect(host.querySelector('[aria-label="Setup assignment"]')).toBeNull()
 await order('Buy',1.098);await click('Next Candle')
 expect(host.querySelectorAll('[data-position-id]').length).toBe(2);expect(button('Buy').disabled).toBe(true)
 await dragStop(1.099,1.0995);await click('Next Candle');await click('Next Candle');await click('Next Candle')
 expect(host.querySelectorAll('[data-position-id]').length).toBe(1)
 const remaining=host.querySelector('[data-position-id]')!.getAttribute('data-position-id')!;await click(`Close ${remaining}`);expect(host.textContent).toContain('Close pending');await click('Next Candle')
 await until(()=>host.querySelector('.save-state')?.textContent==='Saved');const records=await disk.storage.list();const state=records.sessions[0].checkpoint.trading
 expect(state.closed).toHaveLength(2);expect(state.setups).toHaveLength(1);expect(state.closed[0].stopModifications).toHaveLength(1);expect(state.closed[0].exitReason).toBe('stop_loss');expect(state.closed[1].exitReason).toBe('manual')
})
it('reports account equity PnL including fees, and unavailable equity when a required quote is missing',async()=>{
 missingAsk=true;await mount();await input('Round-trip commission (USD per standard lot)','7');await load();await order('Sell',1.103);await click('Next Candle')
 await until(()=>host.querySelector('.save-state')?.textContent==='Saved');const row=(await disk.storage.list()).sessions[0];const state=stateOf(row)
 const net=(state.quote!.bid!.close-state.positions[0].entryPrice)*-100000*state.positions[0].lots-state.positions[0].entryCommissionUsd-state.positions[0].lots*20 // ask spread .0002
 expect(host.querySelector('[aria-label="Account PnL"]')?.textContent).toContain(`$${net.toFixed(2)}`)
 await click('Next Candle');await click('Next Candle');expect(host.querySelector('[aria-label="Account PnL"]')?.textContent).toContain('PnL unavailable')
})
function stateOf(row:Awaited<ReturnType<typeof disk.storage.list>>['sessions'][number]){return row.checkpoint.trading}
it('confirms finishing with open positions, preserves them, and restores finished results without downloads',async()=>{
 await start();await order();await click('Next Candle');vi.mocked(window.confirm).mockReturnValueOnce(false)
 await click('Finish backtest');await until(()=>!host.querySelector<HTMLFieldSetElement>('.workspace-controls')!.disabled);expect(host.querySelector('.phase-trading')).toBeTruthy();expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('1 open positions'))
 await click('Finish backtest');await until(()=>host.querySelector('.phase-finished')&&host.querySelector('.save-state')?.textContent==='Saved')
 expect(host.querySelector('.trading-journal')).toBeTruthy();const record=(await disk.storage.list()).sessions[0];expect(record.checkpoint.lifecycle).toBe('finished');expect(record.checkpoint.trading.positions).toHaveLength(1);expect(record.checkpoint.trading.closed).toHaveLength(0)
 const before=historyCalls;await act(async()=>root.unmount());root=createRoot(host);await mount();await click('Resume backtest');await until(()=>host.querySelector('.phase-finished'));expect(historyCalls).toBe(before);expect(host.querySelector('.stop-placement')).toBeNull()
})
it('restores active sessions paused without drafts and keeps charts alive through next-candle updates',async()=>{
 await start();const count=vi.mocked(createChart).mock.calls.length;await order();await click('Next Candle');expect(vi.mocked(createChart).mock.calls.length).toBe(count)
 await click('Play');await click('Sessions / settings');await click('Save now');await until(()=>host.querySelector('.save-state')?.textContent==='Saved')
 await act(async()=>root.unmount());root=createRoot(host);await mount();await click('Resume backtest');await until(()=>host.querySelector('.phase-trading'))
 expect(host.querySelector('[aria-label="Replay status"]')?.textContent).toBe('Paused');expect(host.querySelector('.stop-placement')).toBeNull()
})
it('migrates digest-verified v1 lifecycle on next save without changing financial data or fingerprints',async()=>{
 const history=sessionHistory(),sim=sessionSimulation(history);sim.observe(3);const store=new DiskSessionStore();const id=crypto.randomUUID(),historyId=await historyFingerprint(history)
 await store.cacheHistory(historyId,history);let record=await store.save({id,name:'Old session',createdAt:new Date().toISOString(),range:{from:history.tradingFrom,to:history.to},historyId,totalCandles:history.bid.length},sim.snapshot(),null)
 const old={...record,schemaVersion:1,checkpoint:{...record.checkpoint}};delete old.checkpoint.lifecycle;old.revision++;old.digest=await recordDigest(old)
 await store.call(`/sessions/${id}/checkpoint`,'PUT',{record:old,chunks:[],expectedRevision:record.revision})
 await mount();await click('Resume backtest');await until(()=>host.querySelector('.phase-trading'));await click('Sessions / settings');await click('Save now');await until(()=>host.querySelector('.save-state')?.textContent==='Saved')
 record=(await disk.storage.list()).sessions[0];expect(record.schemaVersion).toBe(2);expect(record.checkpoint.lifecycle).toBe('trading');expect(record.historyId).toBe(historyId);expect(record.checkpoint.trading).toEqual(old.checkpoint.trading)
})
it('converts inclusive calendar dates without changing exclusive stored ranges',()=>{
 expect(shiftDate('2024-02-29',1)).toBe('2024-03-01');expect(selectedRange('2024-02-29','2024-02-29',coverage).range).toEqual({from:'2024-02-29',to:'2024-03-01'})
 expect(selectedRange('2024-01-01','2024-03-01',coverage).error).toBeTruthy();expect(selectedRange('2003-05-03','2010-07-06',coverage).error).toBeTruthy()
 expect(selectedRange('2024-01-10','2024-01-09',coverage).error).toBeTruthy();expect(selectedRange('2023-11-30','2024-02-29',coverage).error).toBeTruthy()
 expect(accountPnl(createEquityLedger(10000),10000)).toBeNull()
 expect(lifecycleOf({...sessionSimulation().snapshot().checkpoint,lifecycle:undefined})).toBe('setup')
})
it('prevents duplicate clicks while cached startup is active',async()=>{
 await mount();const underlying=globalThis.fetch;let release!:()=>void
 vi.stubGlobal('fetch',async(path:string,options?:RequestInit)=>{if(path.startsWith('/api/history?'))await new Promise<void>(resolve=>{release=resolve});return underlying(path,options)})
 await click('Start backtest');expect(host.textContent).toContain('Preparing charts and indicators');expect(button('Start backtest').disabled).toBe(true)
 await click('Start backtest');await act(async()=>release());await until(()=>host.querySelector('.phase-trading'))
 expect(historyCalls).toBe(1)
})
it('never publishes a finished view when the finished checkpoint fails to save',async()=>{
 await start();await until(()=>host.querySelector('.save-state')?.textContent==='Saved');const underlying=globalThis.fetch
 vi.stubGlobal('fetch',(path:string,options?:RequestInit)=>{
   if(path.includes('/checkpoint')&&typeof options?.body==='string'&&JSON.parse(options.body).record.checkpoint.lifecycle==='finished')return Promise.resolve(new Response(JSON.stringify({error:'Disk write failed',code:'STORAGE_UNAVAILABLE'}),{status:503}))
   return underlying(path,options)
 })
 await click('Finish backtest');await until(()=>host.querySelector('.critical-save'));expect(host.querySelector('.phase-trading')).toBeTruthy();expect(host.querySelector('.phase-finished')).toBeNull();expect((await disk.storage.list()).sessions[0].checkpoint.lifecycle).toBe('trading')
})
it('keeps production chart candles behind the clock and offers explicit review at natural exhaustion',async()=>{
 await start();const candlestick=()=>vi.mocked(chart().addSeries).mock.results[0].value.data()
 expect(candlestick().at(-1).time).toBe(beginning/1000)
 for(let i=1;i<12;i++)await click('Next Candle')
 expect(candlestick().at(-1).time).toBe(beginning/1000);expect(candlestick().at(-1).close).toBe(bid.at(-1)!.close);expect(host.querySelector('.phase-trading')).toBeTruthy();expect(button('Buy').disabled).toBe(true)
 await click('Review Results');await until(()=>host.querySelector('.phase-finished'));expect(host.querySelector('.trading-journal')).toBeTruthy()
})

it('shows an uncached quote, requires confirmation, and preserves the chosen name/start when installing single-price history', async () => {
 const { fixtureHistory } = await import('../../tests/databentoFixture')
 const original = globalThis.fetch, paid = vi.fn()
 vi.stubGlobal('fetch',async(path:string,options?:RequestInit)=>{
  if(path.startsWith('/api/history/estimate'))return new Response(JSON.stringify({id:'fixture-approval',from:'2023-12-10',tradingFrom:'2024-01-09',to:'2024-01-10',cached:false,estimatedUsd:.01,reservedUsd:.02,remainingBudgetUsd:5,downloadAllowed:true,blockedReason:null,expiresAt:'2030-01-01T00:00:00Z',missingRanges:[{from:'2023-12-10',to:'2024-01-10'}]}))
  if(path==='/api/history/download'){paid(options);return new Response(JSON.stringify({...fixtureHistory('2023-12-10','2024-01-10',undefined,true),tradingFrom:'2024-01-09'}))}
  return original(path,options)
 })
 await mount();await input('Backtest name','6E research draft')
 await click('Start backtest');await until(()=>host.querySelector('.paid-download-dialog'))
 expect(paid).not.toHaveBeenCalled();expect(host.textContent).toContain('$0.01')
 expect(button('Approve paid download — Estimated $0.01').disabled).toBe(true)
 await click('Cancel — No download');expect(paid).not.toHaveBeenCalled()
 await click('Start backtest');await until(()=>host.querySelector('.paid-download-dialog'))
 await act(async()=>host.querySelector<HTMLInputElement>('.download-acknowledgement input')!.click())
 await click('Approve paid download — Estimated $0.01');await until(()=>host.querySelector('.phase-trading'))
 expect(paid).toHaveBeenCalledOnce();expect(JSON.parse(paid.mock.calls[0][0].body)).toEqual({quoteId:'fixture-approval',confirm:true})
 expect(host.querySelector('.header-session')?.textContent).toContain('6E research draft')
 expect(host.querySelector('.pane-toolbar .instrument strong')?.textContent).toBe('EURUSD 6E')
 expect(host.querySelector('.pane-toolbar .instrument')?.textContent).toBe('EURUSD 6E')
 expect(host.querySelector('.pane-toolbar .bid-label')).toBeNull()
 expect(host.querySelector('.chart-workspace')?.getAttribute('aria-label')).toBe('EURUSD 6E chart workspace')
 expect(host.querySelector('.execution-details')?.textContent).toContain('6E trade prices')
 expect(host.querySelector('.workspace-toolbar')?.textContent).not.toMatch(/Ready for a new setup|Entries fill|Contract mappings/)

 await until(()=>host.querySelector('.save-state')?.textContent==='Saved')
 const record=(await disk.storage.list()).sessions[0]
 expect(record.symbol).toBe('6E');expect(record.checkpoint.trading.quote).toHaveProperty('trade')
})

it('saves a replacement paid history under a new session before flushing the preserved name', async () => {
 const { fixtureHistory } = await import('../../tests/databentoFixture')
 const original = globalThis.fetch
 let paidMode = false, quote: any
 vi.stubGlobal('fetch',async(path:string,options?:RequestInit)=>{
  if(paidMode && path.startsWith('/api/history/estimate')) {
   const query=new URL(path,'http://local').searchParams,tradingFrom=query.get('from')!,to=query.get('to')!,from=shiftDate(tradingFrom,-30)
   quote={id:'replacement-quote',from,tradingFrom,to,cached:false,estimatedUsd:.01,reservedUsd:.02,remainingBudgetUsd:5,downloadAllowed:true,blockedReason:null,expiresAt:'2030-01-01T00:00:00Z',missingRanges:[{from,to}]}
   return new Response(JSON.stringify(quote))
  }
  if(path==='/api/history/download')return new Response(JSON.stringify({...fixtureHistory(quote.from,quote.to,undefined,true),tradingFrom:quote.tradingFrom}))
  return original(path,options)
 })
 await mount();await load();await until(()=>host.querySelector('.save-state')?.textContent==='Saved')
 const before=(await disk.storage.list()).sessions[0]
 await click('Sessions / settings');await click('New session');await until(()=>host.querySelector('.phase-setup'));await input('Backtest name','Preserved replacement name')
 paidMode=true;await input('From','2024-01-08');await click('Start backtest');await until(()=>host.querySelector('.paid-download-dialog'))
 await act(async()=>host.querySelector<HTMLInputElement>('.download-acknowledgement input')!.click())
 await click('Approve paid download — Estimated $0.01');await until(()=>host.querySelector('.phase-trading') && host.querySelector('.save-state')?.textContent==='Saved')
 expect(host.querySelector('.critical-save')).toBeNull()
 const records=(await disk.storage.list()).sessions
 expect(records).toHaveLength(2)
 const replacement=records.find(record=>record.id!==before.id)!
 expect(replacement.name).toBe('Preserved replacement name')
 expect(replacement.symbol).toBe('6E');expect(replacement.range.from).toBe('2024-01-08')
 expect(records.find(record=>record.id===before.id)!.historyId).toBe(before.historyId)
 expect((await new DiskSessionStore().recover(replacement.id)).record.historyId).toBe(replacement.historyId)
})

it('keeps cache bounds out of the date picker and reaches approval for earlier history, with cached loads still free offline', async () => {
 const original=globalThis.fetch, paid=vi.fn(), estimates:string[]=[]
 const cacheCoverage={...coverage,providerEarliestTimestamp:null,earliestSelectableDate:null,cachedFrom:'2023-12-10',cachedTo:'2024-01-11',cachedDates:32,providerHealth:{status:'cache-validated'}}
 let access=true
 vi.stubGlobal('fetch',async(path:string,options?:RequestInit)=>{
  if(path==='/api/history/coverage')return new Response(JSON.stringify(cacheCoverage))
  if(path==='/api/history/download'){paid();throw Error('No download permitted in date-selection regression')}
  if(path.startsWith('/api/history/estimate')) {
   const query=new URL(path,'http://local').searchParams,from=query.get('from')!,to=query.get('to')!
   estimates.push(from)
   if(from==='2022-01-03') {
    if(!access)return new Response(JSON.stringify({code:'DATABENTO_CONFIGURATION',error:'Set DATABENTO_API_KEY in the backend environment.'}),{status:503})
    const start=shiftDate(from,-30)
    return new Response(JSON.stringify({id:'earlier-history-quote',from:start,tradingFrom:from,to,cached:false,estimatedUsd:.02,reservedUsd:.04,remainingBudgetUsd:5,downloadAllowed:true,blockedReason:null,expiresAt:'2030-01-01T00:00:00Z',missingRanges:[{from:start,to}]}))
   }
  }
  return original(path,options)
 })
 await mount();await until(()=>host.textContent?.includes('No downloaded history yet'))
 const from=host.querySelector<HTMLInputElement>('[aria-label="From"]')!
 expect(from.min).toBe('');expect(host.textContent).not.toContain('Earliest advertised M1')
 expect(host.textContent).toContain('Get more historical data')
 expect(selectedRange('2022-01-01','2022-03-31',cacheCoverage).error).toBeNull()
 expect(selectedRange('2022-01-01','2022-04-01',cacheCoverage).error).toBeTruthy()
 await input('From','2022-01-03');await input('Through','2022-01-04');await click('Start backtest')
 await until(()=>host.querySelector('.paid-download-dialog'))
 expect(estimates).toEqual(['2022-01-03']);expect(host.textContent).toContain('2022-01-03 through 2022-01-04')
 expect(button('Approve paid download — Estimated $0.02').disabled).toBe(true)
 await act(async()=>host.querySelector<HTMLInputElement>('.download-acknowledgement input')!.click())
 expect(button('Approve paid download — Estimated $0.02').disabled).toBe(false)
 await click('Cancel — No download');expect(paid).not.toHaveBeenCalled()
 access=false;await click('Start backtest');await until(()=>host.querySelector('.form-error[role=alert]'))
 expect(host.textContent).toContain('Set DATABENTO_API_KEY');expect(host.textContent).toContain('Get more historical data')
 await input('From','2024-01-09');await input('Through','2024-01-09');await click('Start backtest')
 await until(()=>host.querySelector('.phase-trading'))
 expect(host.querySelector('.phase-trading')).not.toBeNull()
 expect(host.querySelector('.paid-download-dialog')).toBeNull();expect(paid).not.toHaveBeenCalled()
})

async function seedSaved(name = 'Saved research', legacy = false) {
 const store = legacy ? new SessionStore() : new DiskSessionStore(), history = sessionHistory(), sim = sessionSimulation(history)
 sim.observe(5)
 const historyId = await historyFingerprint(history)
 await store.cacheHistory(historyId, history)
 const record = await store.save({ id: crypto.randomUUID(), name, createdAt: new Date().toISOString(), range: { from: history.tradingFrom, to: history.to }, historyId, totalCandles: history.bid.length }, sim.snapshot(), null)
 if (store instanceof SessionStore) await store.close()
 return record
}
it('shows every saved backtest in the startup selector, gives heading focus and starts a separate Setup', async()=>{
 const records = await Promise.all([seedSaved('January research'), seedSaved('February research')])
 await mount()
 expect(host.querySelector('.startup-selection')).not.toBeNull();expect(host.querySelector('dialog')).toBeNull()
 expect(document.activeElement?.textContent).toBe('Choose a backtest')
 expect(host.querySelectorAll('.startup-selection .saved-session')).toHaveLength(2)
 expect(host.querySelector('.startup-selection')?.textContent).toContain('Replay progress: 3%')
 await click('New backtest')
 expect(host.querySelector('.startup-selection')).toBeNull();expect(host.querySelector<HTMLFieldSetElement>('.workspace-controls')!.hidden).toBe(false)
 const preserved = (await disk.storage.list()).sessions
 expect(preserved.map(r=>r.digest).sort()).toEqual(records.map(r=>r.digest).sort())
})
it('restores a selected checkpoint and retains the ordinary management dialog in Trading', async()=>{
 const record = await seedSaved()
 await mount();expect(host.querySelectorAll('.startup-selection .saved-session')).toHaveLength(1)
 await click('Resume backtest');await until(()=>host.querySelector('.phase-trading'))
 expect(host.querySelector('.replay-clock')?.textContent).toContain('2024-01-01 00:05 UTC')
 const timeframe=host.querySelector<HTMLSelectElement>('[aria-label="Chart 1 timeframe"]')!
 expect(timeframe.value).toBe('M1');expect(timeframe.selectedOptions[0].textContent).toBe('M1 (legacy)')
 await select('Chart 1 timeframe','D1');expect([...timeframe.options].map(o=>o.value)).toEqual(['M5','M15','H1','H4','D1'])
 await click('Sessions / settings');expect(host.querySelector('dialog.management-dialog')).not.toBeNull()
 await click('Save now');await until(()=>host.querySelector('.save-state')?.textContent==='Saved')
 const restored = (await disk.storage.list()).sessions[0]
 expect(restored.checkpoint.trading).toEqual(record.checkpoint.trading)
 expect(restored.checkpoint.equity).toEqual(record.checkpoint.equity)
 expect(restored.checkpoint.executionCursor).toBe(record.checkpoint.executionCursor)
 expect(restored.checkpoint.replay.index).toBe(record.checkpoint.replay.index)
 expect(restored.historyId).toBe(record.historyId)
})
it('opens an actionable startup error when disk initialization fails', async()=>{
 const underlying=globalThis.fetch
 vi.stubGlobal('fetch',(path:string,options?:RequestInit)=>path==='/api/storage/status'?Promise.reject(new Error('offline')):underlying(path,options))
 await act(async()=>root.render(<App/>));await until(()=>host.querySelector('.startup-selection [role="alert"]'))
 expect(button('Retry storage connection').disabled).toBe(false);expect(button('New backtest').disabled).toBe(true)
})
it('opens Setup while optional legacy discovery is still pending',async()=>{
 let release!:(value:[])=>void
 vi.spyOn(SessionStore.prototype,'list').mockImplementation(()=>new Promise<[]>(resolve=>{release=resolve}))
 await mount();expect(button('Start backtest').disabled).toBe(false);expect(host.querySelector('.startup-selection')).toBeNull()
 await act(async()=>release([]))
})
it('removes preferences only after backend deletion succeeds and leaves other sessions untouched', async()=>{
 vi.spyOn(PreferenceTabGuard.prototype,'exclusive').mockImplementation(operation=>operation())
 const record=await seedSaved();localStorage.setItem(uiKey(record.id),'target');localStorage.setItem(uiKey('other'),'keep')
 const underlying=globalThis.fetch;let release!:()=>void
 vi.stubGlobal('fetch',async(path:string,options?:RequestInit)=>{
  if(options?.method==='DELETE')await new Promise<void>(resolve=>{release=resolve})
  return underlying(path,options)
 })
 await mount();await click('Delete');expect(localStorage.getItem(uiKey(record.id))).toBe('target')
 await act(async()=>release());await until(()=>!host.querySelector('.saved-session'))
 expect(localStorage.getItem(uiKey(record.id))).toBeNull();expect(localStorage.getItem(uiKey('other'))).toBe('keep')
})
it('keeps preferences when backend deletion fails', async()=>{
 vi.spyOn(PreferenceTabGuard.prototype,'exclusive').mockImplementation(operation=>operation())
 const record=await seedSaved();localStorage.setItem(uiKey(record.id),'keep')
 const underlying=globalThis.fetch
 vi.stubGlobal('fetch',(path:string,options?:RequestInit)=>options?.method==='DELETE'?Promise.resolve(new Response(JSON.stringify({error:'Deletion failed'}),{status:503})):underlying(path,options))
 await mount();await click('Delete');await until(()=>host.textContent?.includes('Deletion failed'))
 expect(localStorage.getItem(uiKey(record.id))).toBe('keep');expect((await disk.storage.list()).sessions).toHaveLength(1)
})
it('keeps preferences shared with a retained legacy original after successful disk deletion', async()=>{
 vi.spyOn(PreferenceTabGuard.prototype,'exclusive').mockImplementation(operation=>operation())
 const original=await seedSaved('Browser original',true),store=new DiskSessionStore(),legacy=new SessionStore()
 await store.migrate(legacy,original.id,async()=>{throw new Error('No download allowed')});await legacy.close()
 localStorage.setItem(uiKey(original.id),'keep');await mount();await click('Delete');await until(()=>!host.querySelector('.saved-session'))
 expect(localStorage.getItem(uiKey(original.id))).toBe('keep');expect((await disk.storage.list()).sessions).toHaveLength(0)
})
it('keeps successful backtest deletion successful if Local Storage removal throws',async()=>{
 vi.spyOn(PreferenceTabGuard.prototype,'exclusive').mockImplementation(operation=>operation())
 const record=await seedSaved();localStorage.setItem(uiKey(record.id),'keep')
 vi.spyOn(Storage.prototype,'removeItem').mockImplementation(()=>{throw new Error('denied')})
 await mount();await click('Delete');await until(()=>!host.querySelector('.saved-session'))
 expect((await disk.storage.list()).sessions).toHaveLength(0);expect(host.textContent).toContain('Backtest deleted. Its UI preferences were retained')
 expect(host.querySelector('.form-error')).toBeNull()
})
it('previews UI cleanup, requires confirmation and revalidates before removing only orphans', async()=>{
 vi.spyOn(PreferenceTabGuard.prototype,'exclusive').mockImplementation(operation=>operation())
 const saved=await seedSaved(),legacy=await seedSaved('Legacy',true)
 for(const id of [saved.id,legacy.id,'orphan'])localStorage.setItem(uiKey(id),'keep')
 localStorage.setItem('unrelated','keep')
 await mount();await click('New backtest');await click('Sessions / settings')
 // The current unsaved session has presentation preferences copied by fresh().
 const activeKeys=Object.keys(localStorage).filter(key=>key.startsWith('forextester:ui:v1:')&&![saved.id,legacy.id,'orphan'].some(id=>key===uiKey(id)))
 expect(activeKeys).toHaveLength(1)
 await click('Clean up unused UI preferences');await until(()=>host.textContent?.includes('1 unused UI preference entries safe to remove'))
 expect(localStorage.getItem(uiKey('orphan'))).toBe('keep')
 vi.mocked(window.confirm).mockReturnValueOnce(false);await click('Confirm UI preference cleanup')
 expect(localStorage.getItem(uiKey('orphan'))).toBe('keep')
 await click('Confirm UI preference cleanup');await until(()=>host.textContent?.includes('Removed 1 UI preference entries'))
 expect(localStorage.getItem(uiKey('orphan'))).toBeNull()
 for(const key of [uiKey(saved.id),uiKey(legacy.id),'unrelated',...activeKeys])expect(localStorage.getItem(key)).not.toBeNull()
 await click('Clean up unused UI preferences');await until(()=>host.textContent?.includes('0 unused UI preference entries safe to remove'))
})
it('refuses cleanup with unreadable disk inventory',async()=>{
 vi.spyOn(PreferenceTabGuard.prototype,'exclusive').mockImplementation(operation=>operation())
 await mount();localStorage.setItem(uiKey('orphan'),'keep');await click('Sessions / settings')
 const underlying=globalThis.fetch
 vi.stubGlobal('fetch',(path:string,options?:RequestInit)=>path==='/api/storage/sessions'?Promise.resolve(new Response(JSON.stringify({sessions:[],errors:[{id:'broken',error:'Unreadable',revision:null}]}))):underlying(path,options))
 await click('Clean up unused UI preferences');await until(()=>host.textContent?.includes('inventory contains unreadable sessions'))
 expect(localStorage.getItem(uiKey('orphan'))).toBe('keep')
})

it('keeps a restored session\'s original start timestamp and indices even when automatic warm-up would choose another start',async()=>{
 const original=await seedSaved()
 await mount();await click('Resume backtest');await until(()=>host.querySelector('.phase-trading'));await click('Sessions / settings');await click('Save now');await until(()=>host.querySelector('.save-state')?.textContent==='Saved')
 const saved=(await disk.storage.list()).sessions[0]
 expect(saved.checkpoint.replay.startTimestamp).toBe(original.checkpoint.replay.startTimestamp)
 expect(saved.checkpoint.replay.startIndex).toBe(original.checkpoint.replay.startIndex)
 expect(saved.checkpoint.replay.index).toBe(original.checkpoint.replay.index)
})
it('keeps an expired quote unsubmitted and asks for a fresh estimate',async()=>{
 const underlying=globalThis.fetch,paid=vi.fn()
 vi.stubGlobal('fetch',async(path:string,options?:RequestInit)=>{
  if(path==='/api/history/download'){paid();throw Error('No paid submission allowed')}
  const response=await underlying(path,options)
  if(path.startsWith('/api/history/estimate')){const quote=await response.json();return new Response(JSON.stringify({...quote,cached:false,estimatedUsd:.01,reservedUsd:.02,expiresAt:'2020-01-01T00:00:00Z',missingRanges:[{from:quote.from,to:quote.to}]}))}
  return response
 })
 await mount();await click('Start backtest');await until(()=>host.querySelector('.paid-download-dialog'))
 expect(host.textContent).toContain('Quote expired');expect(button('Approve paid download — Estimated $0.01').disabled).toBe(true)
 await click('Cancel — No download');expect(paid).not.toHaveBeenCalled();expect(host.querySelector('.phase-setup')).not.toBeNull()
})
it('cancels an in-flight cached load without creating or starting a session',async()=>{
 await mount();const underlying=globalThis.fetch
 vi.stubGlobal('fetch',(path:string,options?:RequestInit)=>path.startsWith('/api/history?')?new Promise((_resolve,reject)=>options?.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')))):underlying(path,options))
 await click('Start backtest');await click('Cancel loading')
 expect(button('Start backtest').disabled).toBe(false);expect(host.querySelector('.phase-trading')).toBeNull();expect((await disk.storage.list()).sessions).toHaveLength(0)
 vi.stubGlobal('fetch',underlying);await load();expect(historyCalls).toBe(1)
})
it('preserves the production rollover blocker after one-click startup',async()=>{
 const {fixtureHistory}=await import('../../tests/databentoFixture'),underlying=globalThis.fetch
 vi.stubGlobal('fetch',async(path:string,options?:RequestInit)=>{
  if(path.startsWith('/api/history?')){
   const source=fixtureHistory('2023-12-10','2024-01-11','2024-01-10')
   source.candles=[...preroll,...bid.slice(0,2),{...bid[0],timestamp:Date.parse('2024-01-10')}].map(bar=>({...bar,volume:'1',instrumentId:bar.timestamp<Date.parse('2024-01-10')?101:202}))
   return new Response(JSON.stringify(source))
  }
  return underlying(path,options)
 })
 await mount();await input('Through','2024-01-10');await load();await click('Next Candle')
 expect(host.querySelector('[aria-label="Replay status"]')?.textContent).toBe('Rollover blocked')
 expect(button('Next Candle').disabled).toBe(true);expect(button('Play').disabled).toBe(true)
 await until(()=>host.querySelector('.save-state')?.textContent==='Saved');expect((await disk.storage.list()).sessions[0].checkpoint.replay.timestamp).toBe(beginning+60000)
})

function activeStopLines() {
 const series = vi.mocked(chart().addSeries).mock.results[0].value as ISeriesApi<'Candlestick'>
 const removed = vi.mocked(series.removePriceLine).mock.calls.map(([line]) => line)
 return vi.mocked(series.createPriceLine).mock.results.map(result => result.value).filter(line => !removed.includes(line) && line.options().color === '#ef9a9a')
}
it('keeps confirmed pending stops visible before a candle and retains the line object on activation', async () => {
 await start(); await order('Buy', 1.099)
 const [line] = activeStopLines(); expect(line.options()).toMatchObject({ price: 1.099, color: '#ef9a9a', lineStyle: 2, axisLabelVisible: true })
 expect(host.querySelector('[data-order-id]')?.textContent).toBe('Pending B11% riskCancel')
 await click('Next Candle'); expect(activeStopLines()).toEqual([line]); expect(line.options()).toMatchObject({ lineStyle: 0 })
 expect(host.querySelector('[data-position-id]')?.textContent).toMatch(/^B1.*lotsEst. net.*Close$/)
})
it('restores both pending stops from durable session state and removes a cancelled one immediately', async () => {
 await start(); await order('Buy', 1.099); await order('Buy', 1.098)
 expect(activeStopLines()).toHaveLength(2)
 await until(() => host.querySelector('.save-state')?.textContent === 'Saved')
 const before = (await disk.storage.list()).sessions[0].checkpoint
 expect(before.trading.pending).toHaveLength(2)
 await act(async () => root.unmount()); root = createRoot(host); await mount(); await click('Resume backtest'); await until(() => host.querySelector('.phase-trading'))
 expect(activeStopLines().map(line => line.options().price)).toEqual([1.099, 1.098])
 expect(host.querySelectorAll('[data-order-id]')).toHaveLength(2)
 expect(host.textContent).toContain('Pending B21% riskCancel')
 await click(`Cancel entry ${before.trading.pending[0].id}`); expect(activeStopLines()).toHaveLength(1)
 expect(activeStopLines()[0].options().price).toBe(1.098)
 expect(host.querySelector('[data-order-id]')?.textContent).toContain('Pending B21% riskCancel')
 await click('Next Candle'); expect(activeStopLines()).toHaveLength(1)
 expect(host.querySelectorAll('[data-position-id]')).toHaveLength(1)
 expect(host.querySelector('[data-position-id]')?.textContent).toMatch(/^B2.*lotsEst. net.*Close$/)
})
it('keeps SL 2 after SL 1 closes and after restoring the existing checkpoint format', async () => {
 await start(); await order('Buy', 1.099); await order('Buy', 1.098); await click('Next Candle')
 const [first, second] = [...host.querySelectorAll('[data-position-id]')].map(row => row.getAttribute('data-position-id')!)
 await click(`Close ${first}`); await click('Next Candle')
 expect(host.querySelectorAll('[data-position-id]')).toHaveLength(1)
 expect(host.querySelector(`[data-position-id="${second}"]`)?.textContent).toMatch(/^B2.*lotsEst. net.*Close$/)
 await until(() => host.querySelector('.save-state')?.textContent === 'Saved')
 const before = (await disk.storage.list()).sessions[0]
 await act(async () => root.unmount()); root = createRoot(host); await mount(); await click('Resume backtest'); await until(() => host.querySelector('.phase-trading'))
 expect(host.querySelector(`[data-position-id="${second}"]`)?.textContent).toMatch(/^B2.*lotsEst. net.*Close$/)
 expect(activeStopLines()).toHaveLength(1)
 await until(() => host.querySelector('.save-state')?.textContent === 'Saved')
 const after = (await disk.storage.list()).sessions[0]
 expect(after.schemaVersion).toBe(before.schemaVersion)
 expect(after.historyId).toBe(before.historyId)
 expect(after.checkpoint.trading).toEqual(before.checkpoint.trading)
})
it('removes a confirmed pending stop when its fill is rejected', async () => {
 const underlying = globalThis.fetch
 vi.stubGlobal('fetch', async (path: string, options?: RequestInit) => {
  const response = await underlying(path, options)
  if (!path.startsWith('/api/history?')) return response
  const data = await response.json()
  for (const side of ['bid', 'ask']) {
   const next = data[side].find((bar: { timestamp: number }) => bar.timestamp === beginning + 60000)
   Object.assign(next, { open: 1.101, high: 1.1012, low: 1.1009, close: 1.1011 })
  }
  return new Response(JSON.stringify(data))
 })
 await start(); await order('Sell', 1.1005); expect(activeStopLines()).toHaveLength(1)
 await click('Next Candle'); expect(activeStopLines()).toHaveLength(0)
 expect(host.textContent).toContain('Entry rejected:')
})

function activeEntryLines() {
 const series = vi.mocked(chart().addSeries).mock.results[0].value as ISeriesApi<'Candlestick'>
 const removed = vi.mocked(series.removePriceLine).mock.calls.map(([line]) => line)
 return vi.mocked(series.createPriceLine).mock.results.map(result => result.value).filter(line => !removed.includes(line) && /\b[BS][12]\b/.test(line.options().title))
}
it('places trade entry above the charts and renders no empty position area when flat', async () => {
 await start()
 const toolbar = host.querySelector('.workspace-toolbar')!, chartArea = host.querySelector('.chart-workspace')!
 expect(toolbar.contains(button('Buy'))).toBe(true)
 expect(host.querySelector('[aria-label="Sizing mode"]')).toBeNull()
 expect(toolbar.contains(host.querySelector('[aria-label="Risk per entry (%)"]'))).toBe(true)
 expect(toolbar.compareDocumentPosition(chartArea) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
 expect(host.querySelector('.trading-dock')).toBeNull()
 expect(host.querySelector('.active-positions')).toBeNull()
 expect(toolbar.textContent).not.toContain('Ready for a new setup')
 expect(toolbar.textContent).not.toContain('Entries fill')
 expect(host.querySelector('.chart-workspace')?.textContent).not.toContain('Contract mappings and rollover events')
 expect(host.querySelector('.pane-toolbar .instrument strong')?.textContent).toBe('EURUSD')
})
it('keeps drafts uncommitted until the on-chart tick is clicked, and retains cancellation and validation', async () => {
 await start(); await click('Buy'); await pick(1.099)
 const annotation = host.querySelector('.draft-stop-annotation')!
 expect(annotation.textContent).toContain('Draft SL · 13.0 pips')
 expect(annotation.firstElementChild?.getAttribute('aria-label')).toBe('Confirm draft stop-loss')
 expect(host.querySelector('[data-order-id]')).toBeNull()
 const tick = button('Confirm draft stop-loss'), toolbarConfirm = button('Confirm order')
 await act(async () => { tick.click(); toolbarConfirm.click(); tick.click() })
 expect(host.querySelectorAll('[data-order-id]')).toHaveLength(1)
 expect(host.querySelector('.draft-stop-annotation')).toBeNull()
 await click('Buy'); await pick(1.2)
 expect(button('Confirm draft stop-loss').disabled).toBe(true)
 await click('Confirm draft stop-loss'); expect(host.querySelectorAll('[data-order-id]')).toHaveLength(1)
 await act(async () => window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})))
 expect(host.querySelector('.draft-stop-annotation')).toBeNull()
})
it('derives two pending entry identities, keeps actual fills and recreates them after durable restore', async () => {
 await start(); await order('Buy',1.099)
 expect(activeEntryLines().map(line=>line.options())).toMatchObject([{title:'Pending B1 (est.)',price:1.1003,lineStyle:1}])
 await order('Buy',1.098)
 expect(activeEntryLines().map(line=>line.options().title)).toEqual(['Pending B1 (est.) · Pending B2 (est.)'])
 await until(()=>host.querySelector('.save-state')?.textContent==='Saved')
 await act(async()=>root.unmount());root=createRoot(host);await mount();await click('Resume backtest');await until(()=>host.querySelector('.phase-trading'))
 expect(activeEntryLines()[0].options().title).toContain('Pending B2 (est.)')
 await click('Next Candle')
 expect(activeEntryLines().map(line=>line.options())).toMatchObject([{title:'B1 · B2',price:1.1003,lineStyle:2}])
 await until(()=>host.querySelector('.save-state')?.textContent==='Saved')
 const before=(await disk.storage.list()).sessions[0].checkpoint.trading
 await act(async()=>root.unmount());root=createRoot(host);await mount();await click('Resume backtest');await until(()=>host.querySelector('.phase-trading'))
 expect(activeEntryLines()[0].options().title).toBe('B1 · B2')
 expect(activeEntryLines()[0].options().price).toBe(before.positions[0].entryPrice)
 const first=before.positions[0].id
 await click(`Close ${first}`);await click('Next Candle')
 expect(activeEntryLines().map(line=>line.options().title)).toEqual(['B2'])
})

it('groups the replay timestamp with Account PnL and discloses execution details from the app header', async () => {
 await start()
 const header = host.querySelector('.app-header')!, info = header.querySelector('.execution-details') as HTMLDetailsElement
 expect(info.open).toBe(false)
 expect(info.querySelector('summary')?.getAttribute('aria-label')).toBe('Execution details')
 await act(async () => info.querySelector('summary')!.click())
 expect(info.open).toBe(true)
 expect(info.textContent).toContain('net breakeven also includes commissions')
 expect(info.textContent).toContain('Original legacy bid/ask execution')
 const timestamp = header.querySelector('time')!
 expect(timestamp.textContent).toMatch(/2024-01-09 .* UTC/)
 expect(timestamp.nextElementSibling?.getAttribute('aria-label')).toBe('Account PnL')
 expect(host.querySelector('.workspace-toolbar time')).toBeNull()
 const pane = host.querySelector('.pane-toolbar')!
 expect(pane.querySelector('select')).not.toBeNull()
 expect(pane.querySelector('.indicator-controls')).not.toBeNull()
 expect(pane.querySelector('.indicator-readiness')?.textContent).toMatch(/Indicators/)
 const options = vi.mocked(createChart).mock.calls.at(-1)![1]!
 expect(options.timeScale).toMatchObject({ fixRightEdge: false, rightOffset: 12 })
})

async function shortcut(key: 'ArrowLeft' | 'ArrowRight', target: EventTarget = window) {
 const event = new KeyboardEvent('keydown', { key, shiftKey: true, bubbles: true, cancelable: true })
 await act(async () => target.dispatchEvent(event))
 return event
}
async function outside(element: Element) {
 await act(async () => {
  element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
 })
}
it('keeps the last clicked or scrolled chart active beyond synchronization expiry and falls back when removed', async () => {
 await start()
 await act(async () => host.querySelector<HTMLInputElement>('input[name="chart-count"][value="3"]')!.click())
 const panes = [...host.querySelectorAll('.chart-pane')]
 expect(panes[0].getAttribute('data-active')).toBe('true')
 await act(async () => panes[2].dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
 expect(panes[2].getAttribute('data-active')).toBe('true')
 vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000)
 expect(panes[2].getAttribute('data-active')).toBe('true')
 const canvas = panes[1].querySelector('.chart-canvas')!
 vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 900, height: 650 } as DOMRect)
 await act(async () => { canvasWheel(canvas, 850, 80) })
 expect(panes[1].getAttribute('data-active')).toBe('true')
 await select('Chart 3 timeframe', 'H1')
 expect(panes[2].getAttribute('data-active')).toBe('true')
 await act(async () => host.querySelector<HTMLInputElement>('input[name="chart-count"][value="2"]')!.click())
 expect(panes[0].getAttribute('data-active')).toBe('true')
 await act(async () => panes[1].dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
 await act(async () => host.querySelector<HTMLInputElement>('input[name="chart-count"][value="1"]')!.click())
 expect(panes[0].getAttribute('data-active')).toBe('true')
})
it('uses percentage risk for both new entries and preserves rounded sizes after fill', async () => {
 await start()
 expect(host.querySelector<HTMLInputElement>('[aria-label="Risk per entry (%)"]')!.value).toBe('1')
 expect(host.textContent).not.toContain('Manual lots')
 await order('Buy', 1.098)
 await input('Risk per entry (%)', '.5'); await order('Buy', 1.097)
 expect([...host.querySelectorAll('[data-order-id]')].map(el => el.textContent)).toEqual([expect.stringContaining('1% risk'), expect.stringContaining('0.5% risk')])
 await click('Next Candle')
 const expectedLots = [1000 / ((1.1003 - 1.098) * 100000), 500 / ((1.1003 - 1.097) * 100000)].map(n => Math.floor(n * 100) / 100)
 for (const lots of expectedLots) expect(host.querySelector('.active-positions')?.textContent).toContain(`${lots} lots`)
})
it('reviews revealed history without changing the durable trading cursor, hides annotations, and restores trading', async () => {
 await start(); await select('Chart 1 timeframe', 'M5'); await order('Buy', 1.098)
 await shortcut('ArrowRight'); expect(host.querySelector('time')?.textContent).toContain('00:04')
 await shortcut('ArrowRight'); expect(host.querySelector('time')?.textContent).toContain('00:09')
 await click('Sessions / settings'); await click('Save now'); await until(() => host.querySelector('.save-state')?.textContent === 'Saved'); await click('Close management')
 const before = (await disk.storage.list()).sessions[0]
 const total = chartForCanvas(host.querySelector('.chart-canvas')!).addSeries.mock.results[0].value.data().length
 await shortcut('ArrowLeft')
 expect(host.querySelector('.history-review')?.textContent).toContain('Reviewing history')
 expect(host.querySelector('time')?.textContent).toContain('00:09')
 expect(button('Buy').disabled).toBe(true); expect(button('Play').disabled).toBe(true)
 expect(host.querySelector('.active-positions')).toBeNull(); expect(activeEntryLines()).toHaveLength(0); expect(activeStopLines()).toHaveLength(0)
 expect(chartForCanvas(host.querySelector('.chart-canvas')!).addSeries.mock.results[0].value.data().length).toBeLessThan(total)
 await click('Sessions / settings'); await click('Save now'); await until(() => host.querySelector('.save-state')?.textContent === 'Saved'); await click('Close management')
 const reviewing = (await disk.storage.list()).sessions[0]
 expect(reviewing.checkpoint.trading).toEqual(before.checkpoint.trading)
 expect(reviewing.checkpoint.executionCursor).toBe(before.checkpoint.executionCursor)
 expect(reviewing.checkpoint.equity).toEqual(before.checkpoint.equity)
 expect(reviewing.checkpoint.replay).toEqual(before.checkpoint.replay)
 await shortcut('ArrowRight'); expect(host.querySelector('.history-review')).toBeNull(); expect(button('Buy').disabled).toBe(false)
 await shortcut('ArrowLeft'); await click('Return to current replay')
 expect(button('Buy').disabled).toBe(false); expect(activeEntryLines()).toHaveLength(1)
})
it('blocks shortcuts in focused editors, open disclosures, management, drafts, and playback', async () => {
 await start(); const clock = () => host.querySelector('time')?.textContent
 const before = clock(), risk = host.querySelector<HTMLInputElement>('[aria-label="Risk per entry (%)"]')!
 for (const element of [risk, host.querySelector('select')!, document.createElement('textarea'), document.createElement('div')]) {
  if (!element.isConnected) { host.append(element); element.setAttribute('contenteditable', 'true') }
  await act(async () => (element as HTMLElement).focus())
  expect((await shortcut('ArrowRight', element)).defaultPrevented).toBe(false); expect(clock()).toBe(before)
  ;(element as HTMLElement).blur()
 }
 for (const selector of ['.execution-details', '.indicator-controls']) {
  await act(async () => { host.querySelector<HTMLDetailsElement>(selector)!.open = true })
  expect((await shortcut('ArrowRight')).defaultPrevented).toBe(false); expect(clock()).toBe(before)
  await act(async () => host.querySelector<HTMLDetailsElement>(selector)!.open = false)
 }
 await click('Sessions / settings'); expect((await shortcut('ArrowRight')).defaultPrevented).toBe(false); await click('Close management')
 await click('Buy'); expect((await shortcut('ArrowRight')).defaultPrevented).toBe(false); await click('Cancel placement')
 await click('Play'); expect((await shortcut('ArrowRight')).defaultPrevented).toBe(false)
 expect(host.querySelector('.keyboard-notice')?.textContent).toContain('Pause replay')
 await click('Pause'); expect(clock()).toBe(before)
 const plain = new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }); window.dispatchEvent(plain)
 expect(plain.defaultPrevented).toBe(false); expect(clock()).toBe(before)
})
it('dismisses execution and indicator disclosures outside and on Escape while retaining valid settings', async () => {
 await start()
 const execution = host.querySelector<HTMLDetailsElement>('.execution-details')!, indicators = host.querySelector<HTMLDetailsElement>('.indicator-controls')!
 for (const details of [execution, indicators]) {
  await act(async () => details.querySelector('summary')!.click()); expect(details.open).toBe(true)
  await outside(details.querySelector('div')!); expect(details.open).toBe(true)
  await outside(host.querySelector('h1')!); expect(details.open).toBe(false)
  await act(async () => details.querySelector('summary')!.click())
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(details.open).toBe(false); expect(document.activeElement).toBe(details.querySelector('summary'))
 }
 await act(async () => indicators.querySelector('summary')!.click())
 await input('Chart 1 BB #1 Length', '25')
 await outside(host.querySelector('h1')!); await act(async () => indicators.querySelector('summary')!.click())
 expect(host.querySelector<HTMLInputElement>('[aria-label="Chart 1 BB #1 Length"]')!.value).toBe('25')
})

it('places one replay control group in the application header and keeps trading below it', async () => {
 await start()
 const header = host.querySelector('.app-header')!, toolbar = host.querySelector('.workspace-toolbar')!
 for (const name of ['Play', 'Pause', 'Next Candle', 'Finish backtest']) {
  expect(header.contains(button(name))).toBe(true)
  expect([...host.querySelectorAll('button')].filter(b => b.textContent === name)).toHaveLength(1)
 }
 expect(header.querySelector('[aria-label="Replay speed"]')).not.toBeNull()
 expect(header.querySelectorAll('input[name="chart-count"]')).toHaveLength(3)
 expect(header.querySelector('[aria-label="Replay status"]')).not.toBeNull()
 expect(header.querySelector('[aria-label="Replay progress"]')).not.toBeNull()
 for (const name of ['Buy', 'Sell']) expect(toolbar.contains(button(name))).toBe(true)
 expect(toolbar.querySelector('[aria-label="Risk per entry (%)"]')).not.toBeNull()
 expect(toolbar.querySelector('.header-replay')).toBeNull()
 await click('Play')
 expect(button('Play').matches(':disabled')).toBe(true)
 expect(button('Next Candle').matches(':disabled')).toBe(true)
 expect(button('Pause').matches(':disabled')).toBe(false)
 await click('Pause'); await click('Sessions / settings')
 for (const control of header.querySelectorAll('.header-replay button, .header-replay select, .header-replay input')) expect(control.matches(':disabled')).toBe(true)
 await click('Close management')
 expect(button('Next Candle').matches(':disabled')).toBe(false)
 await shortcut('ArrowLeft')
 expect(button('Play').matches(':disabled')).toBe(true)
 expect(button('Next Candle').matches(':disabled')).toBe(true)
 expect(button('Finish backtest').matches(':disabled')).toBe(true)
})

it('keeps indicator readiness in the disclosure and updates it for settings, timeframe and replay', async () => {
 await start(); await select('Chart 1 timeframe', 'M5')
 const panel = () => host.querySelector<HTMLDetailsElement>('.indicator-controls')!
 const status = () => panel().querySelector('.indicator-readiness')!
 expect(host.querySelectorAll('.indicator-readiness')).toHaveLength(1)
 expect(host.querySelector('.pane-toolbar > .indicator-readiness')).toBeNull()
 expect(panel().open).toBe(false)
 expect(status().closest('.indicator-options')).not.toBeNull()
 await act(async () => panel().querySelector('summary')!.click())
 expect(panel().open).toBe(true)
 expect(status().textContent).toContain('completed M5 candles')
 await input('Chart 1 BB #1 Length', '200')
 expect(status().textContent).toContain('200')
 await select('Chart 1 timeframe', 'D1')
 expect(panel().open).toBe(false)
 expect(status().textContent).toContain('completed D1 candles')
 expect(status().textContent).toContain('warming up')
 await select('Chart 1 timeframe', 'M5')
 await input('Chart 1 Span B', '1'); await input('Chart 1 Kijun', '1'); await input('Chart 1 Tenkan', '1'); await input('Chart 1 Displacement', '1')
 await input('Chart 1 BB #1 Length', '91')
 // Disable the longer-period overlays so the unchanged warm-up calculation uses the selected Bollinger length.
 for (const label of ['Chart 1 BB #2', 'Chart 1 Stochastic']) {
  const checkbox = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
  if (checkbox.checked) await act(async () => checkbox.click())
 }
 const before = status().textContent
 await shortcut('ArrowRight'); await shortcut('ArrowRight')
 expect(status().textContent).not.toBe(before)
 expect(status().textContent).toContain('Indicators ready')
})

it('preserves all storage and startup fieldset guards after moving replay into the header', async () => {
 await start()
 const original = persistence.useSessionPersistence
 let guards: Partial<ReturnType<typeof original>> = {}
 vi.spyOn(persistence, 'useSessionPersistence').mockImplementation(options => ({ ...original(options), ...guards }))
 for (const state of [{ initialized: false }, { busy: true }, { conflict: true }, { awaitingChoice: true }]) {
  guards = state
  await act(async () => root.render(<StrictMode><App/></StrictMode>))
  expect(host.querySelector('.workspace-controls')!.matches(':disabled')).toBe(true)
  for (const control of host.querySelectorAll('.header-replay button, .header-replay select, .header-replay input')) expect(control.matches(':disabled')).toBe(true)
 }
 guards = {}
 await act(async () => root.render(<StrictMode><App/></StrictMode>))
 expect(button('Next Candle').matches(':disabled')).toBe(false)
 let release!: () => void
 guards = { flush: () => new Promise<void>(resolve => { release = resolve }) }
 await act(async () => root.render(<StrictMode><App/></StrictMode>))
 await click('Finish backtest')
 for (const control of host.querySelectorAll('.header-replay button, .header-replay select, .header-replay input')) expect(control.matches(':disabled')).toBe(true)
 vi.mocked(window.confirm).mockReturnValueOnce(false)
 await act(async () => release())
 expect(button('Next Candle').matches(':disabled')).toBe(false)
})

it('keeps pending, mixed and two open records inside the entry row with full accessible IDs and working actions', async () => {
 await start(); await order('Buy', 1.099)
 const strip = () => host.querySelector('.dock-controls .active-positions')!
 expect(strip().getAttribute('tabindex')).toBe('0')
 expect(strip().querySelectorAll('[data-order-id]')).toHaveLength(1)
 await click('Next Candle')
 expect(strip().querySelectorAll('[data-position-id]')).toHaveLength(1)
 await order('Buy', 1.098)
 expect(strip().querySelectorAll('[data-position-id]')).toHaveLength(1)
 expect(strip().querySelectorAll('[data-order-id]')).toHaveLength(1)
 await click('Next Candle')
 const records = [...strip().querySelectorAll('[data-position-id]')]
 expect(records).toHaveLength(2)
 for (const record of records) {
  const id = record.getAttribute('data-position-id')!
  expect(record.querySelector('button')!.getAttribute('aria-label')).toBe(`Close ${id}`)
  expect(record.getAttribute('data-setup-id')).toBeTruthy()
  expect(record.querySelector('details')).toBeNull()
  expect(record.textContent).toMatch(/^B[12].*lotsEst. net -?\$/)
  expect(record.textContent).not.toMatch(/SL|pips|Modify/)
 }
 const first = records[0].getAttribute('data-position-id')!
 await click('Play')
 expect(host.querySelector('.dock-controls .trading-message')!.textContent).toBe('Pause to trade')
 expect(button(`Close ${first}`).disabled).toBe(true)
 await click('Pause')
 await dragStop(1.099,1.0995)
 await until(() => host.querySelector('.save-state')?.textContent === 'Saved')
 const trading = (await disk.storage.list()).sessions[0].checkpoint.trading
 expect(trading.positions.find(p => p.id === first)!.stopModifications).toHaveLength(1)
 await click(`Close ${first}`); await click('Next Candle')
 expect(strip().querySelectorAll('[data-position-id]')).toHaveLength(1)
})

async function dragStop(from: number, to: number) {
 const canvas=host.querySelector<HTMLElement>('.chart-canvas')!, series=chartForCanvas(canvas).addSeries.mock.results[0].value as ISeriesApi<'Candlestick'>
 const prices=vi.spyOn(series,'priceToCoordinate').mockImplementation((price: number)=>(1.2-price)*1000 as ReturnType<typeof series.priceToCoordinate>)
 const coordinates=vi.spyOn(series,'coordinateToPrice').mockImplementation((y: number)=>1.2-y/1000 as ReturnType<typeof series.coordinateToPrice>)
 vi.spyOn(canvas,'getBoundingClientRect').mockReturnValue({left:0,top:0,width:800,height:500} as DOMRect)
 Object.assign(canvas,{setPointerCapture:()=>{},hasPointerCapture:()=>false,releasePointerCapture:()=>{}})
 const pointer=(type:string,price:number)=>{
  const event=new MouseEvent(type,{bubbles:true,cancelable:true,clientX:80,clientY:(1.2-price)*1000,button:0})
  Object.defineProperty(event,'pointerId',{value:1});canvas.dispatchEvent(event)
 }
 await act(async()=>{pointer('pointerdown',from);pointer('pointermove',to);pointer('pointerup',to)})
 prices.mockRestore();coordinates.mockRestore()
}
