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
 await click('Review browser backtests');expect(host.textContent).toContain('Older browser backtest')
 await click('Close management');expect(host.querySelector('dialog')).toBeNull()
 await act(async()=>root.unmount());root=createRoot(host);await mount()
 expect(host.querySelector('dialog')).toBeNull();expect(historyCalls).toBe(0)
 expect((await legacy.get(original.id)).digest).toBe(original.digest)
 expect((await disk.storage.list()).sessions).toHaveLength(0)
 await click('Review browser backtests');await click('Import to disk');await until(()=>!button('Resume / Manage sessions').disabled)
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
 const before=historyCalls;await act(async()=>root.unmount());root=createRoot(host);await mount();await click('Resume session');await until(()=>host.querySelector('.phase-finished'));expect(historyCalls).toBe(before);expect(host.querySelector('.stop-placement')).toBeNull()
})
it('restores active sessions paused without drafts and keeps charts alive through next-candle updates',async()=>{
 await start();const count=vi.mocked(createChart).mock.calls.length;await order();await click('Next Candle');expect(vi.mocked(createChart).mock.calls.length).toBe(count)
 await click('Play');await click('Sessions / settings');await click('Save now');await until(()=>host.querySelector('.save-state')?.textContent==='Saved')
 await act(async()=>root.unmount());root=createRoot(host);await mount();await click('Resume session');await until(()=>host.querySelector('.phase-trading'))
 expect(host.querySelector('[aria-label="Replay status"]')?.textContent).toBe('Paused');expect(host.querySelector('.stop-placement')).toBeNull()
})
it('migrates digest-verified v1 lifecycle on next save without changing financial data or fingerprints',async()=>{
 const history=sessionHistory(),sim=sessionSimulation(history);sim.observe(3);const store=new DiskSessionStore();const id=crypto.randomUUID(),historyId=await historyFingerprint(history)
 await store.cacheHistory(historyId,history);let record=await store.save({id,name:'Old session',createdAt:new Date().toISOString(),range:{from:history.tradingFrom,to:history.to},historyId,totalCandles:history.bid.length},sim.snapshot(),null)
 const old={...record,schemaVersion:1,checkpoint:{...record.checkpoint}};delete old.checkpoint.lifecycle;old.revision++;old.digest=await recordDigest(old)
 await store.call(`/sessions/${id}/checkpoint`,'PUT',{record:old,chunks:[],expectedRevision:record.revision})
 await mount();await click('Resume session');await until(()=>host.querySelector('.phase-trading'));await click('Sessions / settings');await click('Save now');await until(()=>host.querySelector('.save-state')?.textContent==='Saved')
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
 await click('Load historical data');expect(host.textContent).toContain('chunks downloaded');await click('Cancel loading');expect(button('Load historical data').disabled).toBe(false);expect(button('Start backtest').disabled).toBe(true)
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
 await click('Load historical data');await until(()=>host.textContent?.includes('Fully cached:'))
 expect(paid).not.toHaveBeenCalled();expect(host.textContent).toContain('$0.01000000')
 vi.mocked(window.confirm).mockReturnValueOnce(false)
 await click('Confirm Databento download');expect(paid).not.toHaveBeenCalled()
 await click('Confirm Databento download');await until(()=>host.querySelector('.data-ready'))
 expect(paid).toHaveBeenCalledOnce();expect(JSON.parse(paid.mock.calls[0][0].body)).toEqual({quoteId:'fixture-approval',confirm:true})
 expect((host.querySelector('[aria-label="Backtest name"]') as HTMLInputElement).value).toBe('6E research draft')
 await click('Start backtest');await until(()=>host.querySelector('.save-state')?.textContent==='Saved')
 const record=(await disk.storage.list()).sessions[0]
 expect(record.symbol).toBe('6E');expect(record.checkpoint.trading.quote).toHaveProperty('trade')
})
