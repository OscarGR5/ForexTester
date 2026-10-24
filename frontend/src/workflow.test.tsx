// @vitest-environment jsdom
import { diskApiFixture } from '../../tests/diskApiFixture'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { webcrypto } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createChart, type CandlestickData, type UTCTimestamp } from 'lightweight-charts'
import { App } from './App'
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
  CandlestickSeries: {}, LineSeries: {}, LineStyle: { Dashed: 2, Dotted: 1 }, ColorType: { Solid: 'solid' },
  createChart: vi.fn(() => {
    let range = { from: 0, to: 2 }
    const scale = { getVisibleLogicalRange: () => range, fitContent: vi.fn(),
      setVisibleLogicalRange: (next: typeof range) => { range = next },
      subscribeVisibleLogicalRangeChange: vi.fn(), unsubscribeVisibleLogicalRangeChange: vi.fn() }
    const makeSeries = () => {
    let values: CandlestickData<UTCTimestamp>[] = []
    let autoScale = true, priceRange = { from: 1.09, to: 1.11 }
    const priceScale = { applyOptions: vi.fn((next: { autoScale?: boolean }) => { if (typeof next.autoScale === 'boolean') autoScale = next.autoScale }), options: () => ({ autoScale }), getVisibleRange: () => priceRange, setVisibleRange: vi.fn((next: typeof priceRange) => { priceRange = next }) }
    return {
      setData: vi.fn((next: typeof values) => { values = next.map((candle) => ({ ...candle })) }),
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
      attachPrimitive: vi.fn(), detachPrimitive: vi.fn(), createPriceLine: vi.fn((options) => ({ applyOptions: vi.fn(), options: () => options })), removePriceLine: vi.fn(),
      priceScale: () => priceScale, coordinateToPrice: (y: number) => y / 100000,
    }
    }
    return {
      applyOptions: vi.fn(), subscribeClick: vi.fn(), unsubscribeClick: vi.fn(), addSeries: vi.fn(makeSeries), removeSeries: vi.fn(), remove: vi.fn(),
      panes: () => [{ setStretchFactor: vi.fn() }, { setStretchFactor: vi.fn() }],
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
const bid=Array.from({length:12},(_,i)=>({timestamp:beginning+i*60000,open:1.1+i*.0001,close:1.1001+i*.0001,high:1.1002+i*.0001,low:i===5?1.0985:1.0999+i*.0001}))
beforeEach(async()=>{
 disk=await diskApiFixture();historyCalls=0;missingAsk=false;failHistory=false
 window.localStorage.clear();vi.stubGlobal('indexedDB',new IDBFactory());vi.stubGlobal('IDBKeyRange',IDBKeyRange);vi.stubGlobal('crypto',webcrypto)
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});vi.spyOn(window,'confirm').mockReturnValue(true);vi.clearAllMocks()
 vi.stubGlobal('fetch',async(path:string,options?:RequestInit)=>{
  if(path.startsWith('/api/storage'))return disk.fetch(path,options)
  if(path==='/api/history/coverage')return new Response(JSON.stringify(coverage))
  if(path.startsWith('/api/history/estimate')&&!failHistory) {const params=new URL(path,'http://local').searchParams;return new Response(JSON.stringify({id:'fixture-cached-quote',from:'2023-12-10',tradingFrom:params.get('from'),to:params.get('to'),cached:true,estimatedUsd:0,reservedUsd:0,remainingBudgetUsd:5,downloadAllowed:true,blockedReason:null,expiresAt:'2030-01-01T00:00:00Z',missingRanges:[]}))}
  historyCalls++;if(failHistory)return new Response(JSON.stringify({code:'DATABENTO_AUTH',error:"Databento credentials were rejected.",action:'Check backend configuration.'}),{status:502})
  const params=new URL(path,'http://local').searchParams,from=params.get('from')!,to=params.get('to')!
  return new Response(JSON.stringify({symbol:'EURUSD',resolution:'M1',from,to,bid:bid.filter(b=>b.timestamp>=Date.parse(from)&&b.timestamp<Date.parse(to)),ask:bid.filter(b=>b.timestamp>=Date.parse(from)&&b.timestamp<Date.parse(to)&&(!missingAsk||b.timestamp!==beginning+3*60000)).map(b=>({...b,open:b.open+.0002,close:b.close+.0002,high:b.high+.0002,low:b.low+.0002}))}))
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
async function load(){await click('Load historical data');await until(()=>host.querySelector('.data-ready'))}
async function start(){await mount();await load();await click('Start backtest')}
function chart(){return vi.mocked(createChart).mock.results.filter(r=>r.type==='return').at(-1)!.value}
async function pick(price:number,paneIndex=0){const calls=vi.mocked(chart().subscribeClick).mock.calls;expect(calls.length).toBeGreaterThan(0);await act(async()=>calls.at(-1)![0]({point:{x:100,y:price*100000},paneIndex,seriesData:new Map()} as any))}
async function order(direction='Buy',price=.099+1){await click(direction);await pick(price);await click('Confirm order')}
it('keeps initial setup explicit, bounded and free from automatic downloads under StrictMode',async()=>{
 await mount();expect(historyCalls).toBe(0);expect(host.textContent).toContain('Set up a backtest');expect(host.querySelector('.chart-canvas')).toBeNull()
 const from=host.querySelector<HTMLInputElement>('[aria-label="From"]')!,through=host.querySelector<HTMLInputElement>('[aria-label="Through"]')!
 expect(from.min).toBe(coverage.earliestSelectableDate);expect(through.max).toBe('2024-02-29');expect(through.value).toBe('2024-01-09')
 await click('90 days');expect(host.textContent).toContain('90 calendar days');expect(historyCalls).toBe(0)
 await input('From','2000-01-01');await click('Load historical data');expect(historyCalls).toBe(0)
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
 expect(button('Load historical data').disabled).toBe(false)
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
 await until(()=>host.querySelector('.save-state')?.textContent==='Saved');let records=await disk.storage.list();expect(records.sessions[0].checkpoint.lifecycle).toBe('setup')
 await click('Start backtest');expect(host.querySelector('.chart-canvas')).toBeTruthy();expect(host.querySelector('[aria-label="Starting balance (USD)"]')).toBeNull()
 expect(host.querySelector('.trading-journal')).toBeNull();expect(host.querySelector('[aria-label="Account PnL"]')?.textContent).toContain('$0.00 · 0.00%')
 await until(()=>host.querySelector('.save-state')?.textContent==='Saved');records=await disk.storage.list();expect(records.sessions[0].checkpoint.trading.account.referenceBalance).toBe(15000)
})
it('keeps Databento configuration errors readable and retries only on user action',async()=>{
 failHistory=true;await mount();await click('Load historical data');await until(()=>host.querySelector('.load-error'))
 expect(host.textContent).toContain('Databento credentials were rejected');expect(host.textContent).toContain('Configure Databento on the backend');expect(host.querySelector('.chart-message')).toBeNull()
 failHistory=false;await click('Retry historical data');await until(()=>host.querySelector('.data-ready'))
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
 await mount();await click('Load historical data');await until(()=>host.querySelector('.load-error'))
 expect(host.querySelector('.load-error strong')?.textContent).toBe(title)
 expect(host.querySelector('.load-error')?.textContent).not.toContain('install-browser')
 expect(host.querySelector('.data-ready')).toBeNull();expect(button('Start backtest').disabled).toBe(true)
 expect(button('Retry historical data').disabled).toBe(false)
 if(retryAfterMs!==undefined)expect(host.textContent).toContain('at least 12 seconds')
})
it.each(['Buy','Sell'])('requires chart selection and confirmation for %s; rejects wrong side and ignores oscillator clicks',async(direction)=>{
 await start();await click(direction);await pick(direction==='Buy'?1.102:1.098,1);expect(button('Confirm order').disabled).toBe(true)
 await pick(direction==='Buy'?1.102:1.098);expect(button('Confirm order').disabled).toBe(true)
 await click('Choose another level');await pick(direction==='Buy'?1.099:1.103)
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
 const setupOption=host.querySelector<HTMLSelectElement>('[aria-label="Setup assignment"]')!.options[1].value
 await select('Setup assignment',setupOption);await order('Buy',1.098);await click('Next Candle')
 expect(host.querySelectorAll('[data-position-id]').length).toBe(2);expect(button('Buy').disabled).toBe(true)
 await click(`Modify SL ${first}`);await pick(1.0995);expect(host.querySelector(`[data-position-id="${first}"]`)!.textContent).toContain('1.09900')
 await click('Confirm SL change');await click('Next Candle');await click('Next Candle');await click('Next Candle')
 expect(host.querySelectorAll('[data-position-id]').length).toBe(1)
 const remaining=host.querySelector('[data-position-id]')!.getAttribute('data-position-id')!;await click(`Close ${remaining}`);expect(host.textContent).toContain('Close pending');await click('Next Candle')
 await until(()=>host.querySelector('.save-state')?.textContent==='Saved');const records=await disk.storage.list();const state=records.sessions[0].checkpoint.trading
 expect(state.closed).toHaveLength(2);expect(state.setups).toHaveLength(1);expect(state.closed[0].stopModifications).toHaveLength(1);expect(state.closed[0].exitReason).toBe('stop_loss');expect(state.closed[1].exitReason).toBe('manual')
})
it('reports account equity PnL including fees, and unavailable equity when a required quote is missing',async()=>{
 missingAsk=true;await mount();await input('Round-trip commission (USD per standard lot)','7');await load();await click('Start backtest');await order('Sell',1.103);await click('Next Candle')
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
it('keeps cancelled data loading in Setup and requires an explicit retry',async()=>{
 await mount();const underlying=globalThis.fetch
 vi.stubGlobal('fetch',(path:string,options?:RequestInit)=>path.startsWith('/api/history?')?new Promise((_resolve,reject)=>options?.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')))):underlying(path,options))
 await click('Load historical data');expect(host.textContent).toContain('history chunks loaded');await click('Cancel loading');expect(button('Load historical data').disabled).toBe(false);expect(button('Start backtest').disabled).toBe(true)
 vi.stubGlobal('fetch',underlying);await load();expect(button('Start backtest').disabled).toBe(false)
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
 expect(candlestick().at(-1).time).toBe((beginning+11*60000)/1000);expect(host.querySelector('.phase-trading')).toBeTruthy();expect(button('Buy').disabled).toBe(true)
 await click('Review Results');await until(()=>host.querySelector('.phase-finished'));expect(host.querySelector('.trading-journal')).toBeTruthy()
})

it('shows an uncached quote, requires confirmation, and preserves the chosen name/start when installing single-price history', async () => {
 const { fixtureHistory } = await import('../../tests/databentoFixture')
 const original = globalThis.fetch, paid = vi.fn()
 vi.stubGlobal('fetch',async(path:string,options?:RequestInit)=>{
  if(path.startsWith('/api/history/estimate'))return new Response(JSON.stringify({id:'fixture-approval',from:'2023-12-10',tradingFrom:'2024-01-09',to:'2024-01-10',cached:false,estimatedUsd:.01,reservedUsd:.02,remainingBudgetUsd:5,downloadAllowed:true,blockedReason:null,expiresAt:'2030-01-01T00:00:00Z',missingRanges:[{from:'2023-12-10',to:'2024-01-10'}]}))
  if(path==='/api/history/download'){paid(options);return new Response(JSON.stringify({...fixtureHistory('2023-12-10','2024-01-10'),tradingFrom:'2024-01-09'}))}
  return original(path,options)
 })
 await mount();await input('Backtest name','6E research draft');await input('Replay start (UTC)','2024-01-09T00:00')
 await click('Load historical data');await until(()=>host.querySelector('.paid-download-dialog'))
 expect(paid).not.toHaveBeenCalled();expect(host.textContent).toContain('$0.01')
 expect(button('Approve paid download — Estimated $0.01').disabled).toBe(true)
 await click('Cancel — No download');expect(paid).not.toHaveBeenCalled()
 await click('Load historical data');await until(()=>host.querySelector('.paid-download-dialog'))
 await act(async()=>host.querySelector<HTMLInputElement>('.download-acknowledgement input')!.click())
 await click('Approve paid download — Estimated $0.01');await until(()=>host.querySelector('.data-ready'))
 expect(paid).toHaveBeenCalledOnce();expect(JSON.parse(paid.mock.calls[0][0].body)).toEqual({quoteId:'fixture-approval',confirm:true})
 expect((host.querySelector('[aria-label="Backtest name"]') as HTMLInputElement).value).toBe('6E research draft')
 await click('Start backtest');await until(()=>host.querySelector('.save-state')?.textContent==='Saved')
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
  if(path==='/api/history/download')return new Response(JSON.stringify({...fixtureHistory(quote.from,quote.to),tradingFrom:quote.tradingFrom}))
  return original(path,options)
 })
 await mount();await load();await until(()=>host.querySelector('.save-state')?.textContent==='Saved')
 const before=(await disk.storage.list()).sessions[0]
 await input('Backtest name','Preserved replacement name')
 paidMode=true;await input('From','2024-01-08');await click('Load historical data');await until(()=>host.querySelector('.paid-download-dialog'))
 await act(async()=>host.querySelector<HTMLInputElement>('.download-acknowledgement input')!.click())
 await click('Approve paid download — Estimated $0.01');await until(()=>host.querySelector('.data-ready') && host.querySelector('.save-state')?.textContent==='Saved')
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
 await mount();await until(()=>host.textContent?.includes('Validated local cache'))
 const from=host.querySelector<HTMLInputElement>('[aria-label="From"]')!
 expect(from.min).toBe('');expect(host.textContent).not.toContain('Earliest advertised M1')
 expect(host.textContent).toContain('Additional data requires Databento access')
 expect(selectedRange('2022-01-01','2022-03-31',cacheCoverage).error).toBeNull()
 expect(selectedRange('2022-01-01','2022-04-01',cacheCoverage).error).toBeTruthy()
 await input('From','2022-01-03');await input('Through','2022-01-04');await click('Load historical data')
 await until(()=>host.querySelector('.paid-download-dialog'))
 expect(estimates).toEqual(['2022-01-03']);expect(host.textContent).toContain('2022-01-03 through 2022-01-04')
 expect(button('Approve paid download — Estimated $0.02').disabled).toBe(true)
 await act(async()=>host.querySelector<HTMLInputElement>('.download-acknowledgement input')!.click())
 expect(button('Approve paid download — Estimated $0.02').disabled).toBe(false)
 await click('Cancel — No download');expect(paid).not.toHaveBeenCalled()
 access=false;await click('Load historical data');await until(()=>host.querySelector('.load-error'))
 expect(host.textContent).toContain('Set DATABENTO_API_KEY');expect(host.textContent).toContain('Additional data requires Databento access')
 await input('From','2024-01-09');await input('Through','2024-01-09');await click('Retry historical data')
 await until(()=>host.querySelector('.data-ready'))
 expect(host.querySelector('.cached-history-status')?.textContent).toContain('$0.00')
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
 await mount();expect(button('Load historical data').disabled).toBe(false);expect(host.querySelector('.startup-selection')).toBeNull()
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
