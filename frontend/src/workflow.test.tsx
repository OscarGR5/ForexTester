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
import * as dock from './TradingDock'
import * as tradingHook from './useTrading'
import * as replayHook from './useReplay'
import { selectedRange, shiftDate, accountPnl } from './workflow'
import { PreferenceTabGuard } from './uiPreferenceCleanup'
import { uiKey } from './uiPreferences'
import type { WorkspaceSettings } from './sessionTypes'
import { isLocalForex, VISIBLE_TIMEFRAMES } from './history'
import * as preferences from './uiPreferences'
import { SessionStore } from './sessionStore'
import { DiskSessionStore } from './diskSessionStore'
import { recordDigest, historyFingerprint, equitySuffix } from './sessionCodec'
import { sessionHistory, sessionSimulation } from './sessionFixtures'
import { createEquityLedger } from './equity'
import { lifecycleOf } from './sessionTypes'
import { combinedOpenPnl, markPosition } from './trading'
import { TradeOverlays } from './tradeOverlays'
import { RegressionChannelPrimitive } from './RegressionChannelPrimitive'
import { UntakenLevelsPrimitive } from './UntakenLevelsPrimitive'
import { ChartPane } from './ChartPane'
import { ChartSynchronizer } from './chartSync'
import { defaultIndicatorSettings } from './indicators'
import { GLOBAL_UI_ID } from './uiPreferences'
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
      panes: () => [{ getHeight: () => 500, getStretchFactor: () => 3, setStretchFactor: vi.fn() }, { getHeight: () => 100, getStretchFactor: () => 1, setStretchFactor: vi.fn() }],
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
const presetFrom=Date.UTC(2024,0,9)
const preroll=Array.from({length:78},(_,i)=>({timestamp:presetFrom-(78-i)*86_400_000,open:1.1,high:1.1002,low:1.0999,close:1.1001}))
const bid=Array.from({length:12},(_,i)=>({timestamp:beginning+i*60000,open:1.1+i*.0001,close:1.1001+i*.0001,high:1.1002+i*.0001,low:i===5?1.0985:1.0999+i*.0001}))
beforeEach(async()=>{
 disk=await diskApiFixture();historyCalls=0;missingAsk=false;failHistory=false
 window.localStorage.clear();vi.stubGlobal('indexedDB',new IDBFactory());vi.stubGlobal('IDBKeyRange',IDBKeyRange);vi.stubGlobal('crypto',webcrypto)
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});vi.spyOn(window,'confirm').mockReturnValue(true);vi.clearAllMocks()
 vi.stubGlobal('fetch',async(path:string,options?:RequestInit)=>{
  if(path.startsWith('/api/storage'))return disk.fetch(path,options)
  if(path==='/api/history/datasets')return new Response(JSON.stringify({datasets:[{symbol:'EURUSD',tradingEnabled:true}]}))
  if(path.startsWith('/api/history/calendar'))return new Response(JSON.stringify({days:Array.from({length:Math.ceil((Date.parse('2024-01-10')-preroll[0].timestamp)/86_400_000)},(_,i)=>{
    const date=shiftDate(new Date(preroll[0].timestamp).toISOString().slice(0,10),i),bars=[...preroll,bid[0]].filter(b=>b.timestamp>=Date.parse(date)&&b.timestamp<Date.parse(shiftDate(date,1)))
    return {date,status:bars.length?'cached':'gap',observations:bars.length,h4:bars}
  })}))
  if(path==='/api/history/coverage')return new Response(JSON.stringify(coverage))

  historyCalls++;if(failHistory)return new Response(JSON.stringify({code:'DATABENTO_AUTH',error:"Databento credentials were rejected.",action:'Check backend configuration.'}),{status:502})
  const params=new URL(path,'http://local').searchParams,from=params.get('from')!,to=params.get('to')!
  return new Response(JSON.stringify({symbol:'EURUSD',resolution:'M1',from,to,bid:[...preroll,...bid].filter(b=>b.timestamp>=Date.parse(from)&&b.timestamp<Date.parse(to)),ask:[...preroll,...bid].filter(b=>b.timestamp>=Date.parse(from)&&b.timestamp<Date.parse(to)&&(!missingAsk||b.timestamp!==beginning+3*60000)).map(b=>({...b,open:b.open+.0002,close:b.close+.0002,high:b.high+.0002,low:b.low+.0002}))}))
 })
 host=document.createElement('div');document.body.append(host);root=createRoot(host)
})
afterEach(async()=>{await act(async()=>root.unmount());host.remove();await disk.close();vi.restoreAllMocks();vi.unstubAllGlobals()})
async function until(check:()=>unknown){for(let i=0;i<2000;i++){if(check())return;await act(async()=>{await delay(3)})}throw Error(host.textContent!)}
async function mount(){await act(async()=>root.render(<StrictMode><App/></StrictMode>));await until(()=>!host.querySelector<HTMLFieldSetElement>('.workspace-controls')?.disabled||host.querySelector('.saved-session'))}
function button(name:string){const result=[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===name||b.getAttribute('aria-label')===name);if(!result)throw Error(`Missing ${name}: ${host.textContent}`);return result}
async function click(name:string){await act(async()=>button(name).click())}
async function input(label:string,value:string){const el=host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;expect(el).toBeTruthy();await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}))})}
async function select(label:string,value:string){const el=host.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!;await act(async()=>{el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}))})}
async function load(){await click('Start backtest');await until(()=>host.querySelector('.phase-trading'))}
async function start(){await mount();await act(async()=>host.querySelector<HTMLInputElement>('input[name="chart-count"][value="1"]')!.click());await load()}
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
it('shares one M1 regression through four charts, timeframe switches, review, replacement, toggle changes and disk restore', async () => {
 const update = vi.spyOn(RegressionChannelPrimitive.prototype, 'update')
 const hit = vi.spyOn(RegressionChannelPrimitive.prototype, 'containsPoint').mockReturnValue(false)
 await start(); await select('Chart 1 timeframe', 'M5')
 expect(button('Regression').getAttribute('aria-pressed')).toBe('false')
 let selectedTime = beginning / 1000
 const ctrlClick = async (pane = 0) => {
  const canvas = host.querySelectorAll('.chart-canvas')[pane], active = chartForCanvas(canvas)
  Object.assign(active.timeScale(), { coordinateToTime: () => selectedTime })
  const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 100, clientY: 100, ctrlKey: true })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  await act(async () => canvas.dispatchEvent(event))
  const up = new MouseEvent('pointerup', { bubbles: true, cancelable: true, ctrlKey: true })
  Object.defineProperty(up, 'pointerId', { value: 1 }); canvas.dispatchEvent(up)
  return event
 }
 await click('Regression')
 expect((await ctrlClick()).defaultPrevented).toBe(true)
 expect(update.mock.calls.at(-1)![0]).toBeNull()
 for (let i = 0; i < 3; i++) await click('Next Min')
 const fit = update.mock.calls.at(-1)![0]!
 expect(fit.count).toBe(4)
 for (const timeframe of ['H1', 'D1', 'M5']) {
  await select('Chart 1 timeframe', timeframe)
  expect(update.mock.calls.at(-1)![0]).toBe(fit)
 }
 await act(async () => host.querySelector<HTMLInputElement>('input[name="chart-count"][value="4"]')!.click())
 const live = [...host.querySelectorAll('.chart-canvas')].map(canvas => {
  const series = vi.mocked(chartForCanvas(canvas).addSeries).mock.results[0].value
  return vi.mocked(series.attachPrimitive).mock.calls.map(([primitive]: [unknown]) => primitive).find((p: unknown) => p instanceof RegressionChannelPrimitive)!
 })
 expect(live).toHaveLength(4)
 for (const primitive of live) {
  const call = update.mock.contexts.map((context, i) => context === primitive ? i : -1).filter(i => i >= 0).at(-1)!
  expect(update.mock.calls[call][0]).toBe(fit)
 }
 await shortcut('ArrowLeft', window, true)
 expect(update.mock.calls.at(-1)![0]!.count).toBe(3)
 await shortcut('ArrowLeft', window, true)
 expect(update.mock.calls.at(-1)![0]).toBeNull()
 await click('Return to current replay')
 expect(update.mock.calls.at(-1)![0]).toEqual(fit)
 const candleSeries = [...host.querySelectorAll('.chart-canvas')].map(canvas => vi.mocked(chartForCanvas(canvas).addSeries).mock.results[0].value)
 const candlesBefore = candleSeries.map(series => series.data())
 selectedTime = preroll.at(-1)!.timestamp / 1000
 await ctrlClick(2)
 const replacement = update.mock.calls.at(-1)![0]!
 expect(replacement.count).toBe(5)
 await click('Regression')
 expect(button('Regression').getAttribute('aria-pressed')).toBe('false')
 selectedTime = preroll.at(-2)!.timestamp / 1000
 expect((await ctrlClick(2)).defaultPrevented).toBe(false)
 expect(update.mock.calls.at(-1)![0]).toBe(replacement)
 for (const [i, series] of candleSeries.entries()) expect(series.data()).toBe(candlesBefore[i])
 await until(() => host.querySelector('.save-state')?.textContent === 'Saved')
 const saved = (await new DiskSessionStore().list())[0]
 expect(saved.checkpoint.regressionAnchor).toBe(preroll.at(-1)!.timestamp)
 await act(async () => root.unmount()); root = createRoot(host)
 await mount(); await click('Resume backtest'); await until(() => host.querySelector('.phase-trading'))
 expect(update.mock.calls.at(-1)![0]).toEqual(replacement)
 expect(button('Regression').getAttribute('aria-pressed')).toBe('false')
 expect(host.querySelectorAll('.chart-pane')).toHaveLength(4)
 await click('Regression')
 await until(() => host.querySelector('.save-state')?.textContent === 'Saved')
 await act(async () => root.unmount()); root = createRoot(host)
 await mount(); await click('Resume backtest'); await until(() => host.querySelector('.phase-trading'))
 expect(button('Regression').getAttribute('aria-pressed')).toBe('true')
 expect(update.mock.calls.at(-1)![0]).toEqual(replacement)
 hit.mockReturnValue(true)
 await ctrlClick(2)
 expect(update.mock.calls.slice(-4).map(([fit]) => fit)).toEqual([null, null, null, null])
 expect(button('Regression').getAttribute('aria-pressed')).toBe('true')
 await until(() => host.querySelector('.save-state')?.textContent === 'Saved')
 expect((await new DiskSessionStore().list())[0].checkpoint.regressionAnchor).toBeNull()
 await act(async () => root.unmount()); root = createRoot(host)
 await mount(); await click('Resume backtest'); await until(() => host.querySelector('.phase-trading'))
 expect(update.mock.calls.slice(-4).map(([fit]) => fit)).toEqual([null, null, null, null])
 expect(button('Regression').getAttribute('aria-pressed')).toBe('true')
 hit.mockReturnValue(false)
 await ctrlClick(2)
 expect(update.mock.calls.at(-1)![0]).not.toBeNull()
}, 20000)
it('admits M5 levels only at candle close, takes them with forming wicks, and restores them on backward replay', async () => {
 const source = Array.from({ length: 81 }, (_, i) => ({ timestamp: beginning + i * 60000,
  open: 1.1, close: 1.1, high: i < 75 ? 1.11 : 1.12, low: i < 75 ? 1.09 : 1.08 }))
 const rays = vi.spyOn(UntakenLevelsPrimitive.prototype, 'setData'), synchronizer = new ChartSynchronizer()
 const settings = defaultIndicatorSettings(), untaken = { enabled: true, count: 10 }
 const render = (count: number) => act(async () => root.render(<ChartPane id={0} sessionId={null} timeframe="M5" source={source} count={count}
  synchronizer={synchronizer} settings={settings} onSettingsChange={() => {}} onTimeframeChange={() => {}}
  untaken={untaken} stops={[]} positions={[]} placement={null} onPick={() => {}} />))
 const prices = () => rays.mock.lastCall![0].map(level => level.price)
 await render(76); expect(prices()).toEqual([])
 await render(79); expect(prices()).toEqual([])
 await render(80); expect(prices()).toEqual([1.12, 1.08])
 const closed = rays.mock.lastCall![0]
 await render(81); expect(prices()).toEqual([])
 await render(80); expect(rays.mock.lastCall![0]).toEqual(closed)
 await render(79); expect(prices()).toEqual([])
 await render(80); expect(rays.mock.lastCall![0]).toEqual(closed)
})
it('preserves untaken visibility and replaces former saved settings with the default count', async () => {
 localStorage.setItem(uiKey(GLOBAL_UI_ID), JSON.stringify({ untakenLevels: { enabled: true, distanceAtr: 5 } }))
 await start()
 expect(host.querySelector<HTMLInputElement>('[aria-label="Chart 1 Untaken Highs & Lows"]')!.checked).toBe(true)
 expect(host.querySelector<HTMLInputElement>('[aria-label="Chart 1 Untaken Levels"]')!.value).toBe('10')
 expect(JSON.parse(localStorage.getItem(uiKey(GLOBAL_UI_ID))!).untakenLevels).toEqual({ enabled: true, count: 10 })
})
it('shares untaken settings across four independent panes, persists them after remount, and keeps legacy workspace preferences', async () => {
 await start()
 const rays = vi.spyOn(UntakenLevelsPrimitive.prototype, 'setData')
 await act(async () => host.querySelector<HTMLInputElement>('input[name="chart-count"][value="4"]')!.click())
 const toggles = () => [...host.querySelectorAll<HTMLInputElement>('input[aria-label$="Untaken Highs & Lows"]')]
 expect(toggles().map(input => input.checked)).toEqual([false, false, false, false])
 expect([...host.querySelectorAll<HTMLInputElement>('input[aria-label$="Untaken Levels"]')].map(input => input.value)).toEqual(['10', '10', '10', '10'])
 await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', cancelable: true })))
 expect(toggles().map(input => input.checked)).toEqual([true, true, true, true])
 expect(rays.mock.instances.slice(-4).length).toBe(4)
 await input('Chart 3 Untaken Levels', '3')
 expect([...host.querySelectorAll<HTMLInputElement>('input[aria-label$="Untaken Levels"]')].map(input => input.value)).toEqual(['3', '3', '3', '3'])
 await input('Chart 3 Untaken Levels', '2.5')
 expect(host.querySelector('[aria-label="Chart 3 Untaken Levels"]')!.getAttribute('aria-invalid')).toBe('true')
 await input('Chart 3 Untaken Levels', '0')
 expect(JSON.parse(localStorage.getItem(uiKey(GLOBAL_UI_ID))!).untakenLevels).toEqual({ enabled: true, count: 3 })
 await input('Chart 3 Untaken Levels', '15')
 const before = [...host.querySelectorAll<HTMLSelectElement>('select[aria-label$="timeframe"]')].map(input => input.value)
 expect(new Set(before).size).toBe(4)
 await until(() => host.querySelector('.save-state')?.textContent === 'Saved')
 await act(async () => root.render(null))
 await mount()
 await until(() => host.querySelector('.saved-session'))
 await click('Resume backtest')
 await until(() => host.querySelector('.phase-trading'))
 expect(toggles().map(input => input.checked)).toEqual([true, true, true, true])
 expect([...host.querySelectorAll<HTMLInputElement>('input[aria-label$="Untaken Levels"]')].map(input => input.value)).toEqual(['15', '15', '15', '15'])
 await act(async () => toggles()[1].click())
 expect(toggles().map(input => input.checked)).toEqual([false, false, false, false])
 expect(rays.mock.calls.slice(-4).every(([levels]) => levels.length === 0)).toBe(true)
})
it.each([1, 2, 3, 4])('scales only the hovered price axis in a %s-chart layout and retains plot wheel zoom', async count => {
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
 expect(from.min).toBe(new Date(preroll[0].timestamp).toISOString().slice(0,10));expect(through.max).toBe('');expect(through.value).toBe('2024-01-09')
 expect(host.querySelector<HTMLInputElement>('[aria-label="Backtest name"]')?.value).toBe('Untitled backtest')
 expect(host.querySelector<HTMLInputElement>('[aria-label="Round-trip commission (USD per standard lot)"]')?.value).toBe('7')
 expect(host.querySelector<HTMLInputElement>('input[name="chart-count"][value="2"]')?.checked).toBe(true)
 expect(button('90 days').disabled).toBe(true);expect(button('365 days').disabled).toBe(true);expect(historyCalls).toBe(0)
 await click('Random Range');expect(host.textContent).toContain('No cached 120-day replay window');expect(historyCalls).toBe(0)
 await input('From','2023-01-01');await click('Start backtest');expect(historyCalls).toBe(0)
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
 expect(host.querySelector('.results-primary')).toBeNull();expect(host.querySelector('[aria-label="Account PnL"]')?.textContent).toContain('$0.00 · 0.00%')
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
 await click('Next Min');expect(host.querySelectorAll('[data-position-id]').length).toBe(1)
})
it('cancels drafts on Escape, play, restart and session switch without submitting orders',async()=>{
 await start();await click('Buy');await pick(1.099);await act(async()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})));expect(host.querySelector('.stop-placement')).toBeNull()
 await click('Buy');await click('Play');expect(host.querySelector('.stop-placement')).toBeNull();expect(button('Buy').disabled).toBe(true);await click('Pause')
 await click('Buy');await click('Sessions / settings');await click('Restart backtest');expect(host.querySelector('.stop-placement')).toBeNull()
 await click('Buy');await click('Sessions / settings');await click('New session');await until(()=>host.querySelector('[aria-label="Backtest setup"]'));expect(host.querySelector('.stop-placement')).toBeNull()
})
it('maintains independent stops and setup grouping, changes stop history, executes one stop and one manual close',async()=>{
 await start();await order('Buy',1.099);await click('Next Min')
 const first=host.querySelector('[data-position-id]')!.getAttribute('data-position-id')!
 expect(host.querySelector('[aria-label="Setup assignment"]')).toBeNull()
 await order('Buy',1.098);await click('Next Min')
 expect(host.querySelectorAll('[data-position-id]').length).toBe(2);expect(button('Buy').disabled).toBe(true)
 await dragStop(1.099,1.0995);await click('Next Min');await click('Next Min');await click('Next Min')
 expect(host.querySelectorAll('[data-position-id]').length).toBe(1)
 const remaining=host.querySelector('[data-position-id]')!.getAttribute('data-position-id')!;await click(`Close ${remaining}`);expect(host.textContent).toContain('Close pending');await click('Next Min')
 await until(()=>host.querySelector('.save-state')?.textContent==='Saved');const records=await disk.storage.list();const state=records.sessions[0].checkpoint.trading
 expect(state.closed).toHaveLength(2);expect(state.setups).toHaveLength(1);expect(state.closed[0].stopModifications).toHaveLength(1);expect(state.closed[0].exitReason).toBe('stop_loss');expect(state.closed[1].exitReason).toBe('manual')
})
it('reports account equity PnL including fees, and unavailable equity when a required quote is missing',async()=>{
 missingAsk=true;await mount();await input('Round-trip commission (USD per standard lot)','7');await load();await order('Sell',1.103);await click('Next Min')
 await until(()=>host.querySelector('.save-state')?.textContent==='Saved');const row=(await disk.storage.list()).sessions[0];const state=stateOf(row)
 const net=(state.quote!.bid!.close-state.positions[0].entryPrice)*-100000*state.positions[0].lots-state.positions[0].entryCommissionUsd-state.positions[0].lots*20 // ask spread .0002
 expect(host.querySelector('[aria-label="Account PnL"]')?.textContent).toContain(`$${net.toFixed(2)}`)
 await click('Next Min');await click('Next Min');expect(host.querySelector('[aria-label="Account PnL"]')?.textContent).toContain('PnL unavailable')
})
function stateOf(row:Awaited<ReturnType<typeof disk.storage.list>>['sessions'][number]){return row.checkpoint.trading}
it('confirms finishing with open positions, preserves them, and restores finished results without downloads',async()=>{
 await start();await order();await click('Next Min');vi.mocked(window.confirm).mockReturnValueOnce(false)
 await click('Finish backtest');await until(()=>!host.querySelector<HTMLFieldSetElement>('.workspace-controls')!.disabled);expect(host.querySelector('.phase-trading')).toBeTruthy();expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('1 open positions'))
 await click('Finish backtest');await until(()=>host.querySelector('.phase-finished')&&host.querySelector('.save-state')?.textContent==='Saved')
 expect(host.querySelector('.results-primary')).toBeTruthy();const record=(await disk.storage.list()).sessions[0];expect(record.checkpoint.lifecycle).toBe('finished');expect(record.checkpoint.trading.positions).toHaveLength(1);expect(record.checkpoint.trading.closed).toHaveLength(0)
 const before=historyCalls;await act(async()=>root.unmount());root=createRoot(host);await mount();await click('Resume backtest');await until(()=>host.querySelector('.phase-finished'));expect(historyCalls).toBe(before);expect(host.querySelector('.stop-placement')).toBeNull()
})
it('resumes a restored finished backtest paused, preserves every record, reloads Trading, and counts subsequent trades', async () => {
 await start(); await order(); await click('Next Min')
 const id=host.querySelector('[data-position-id]')!.getAttribute('data-position-id')!
 await click(`Close ${id}`); await click('Next Min')
 await click('Finish backtest'); await until(()=>host.querySelector('.phase-finished')&&host.querySelector('.save-state')?.textContent==='Saved')
 const store=new DiskSessionStore(), before=(await disk.storage.list()).sessions[0]
 const recovered=await store.recover(before.id,async()=>{throw Error('History download forbidden')})
 expect(before.checkpoint.trading.closed).toHaveLength(1)
 const historyBefore=historyCalls
 await act(async()=>root.unmount()); root=createRoot(host); await mount(); await click('Resume backtest')
 await until(()=>host.querySelector('.phase-finished')&&host.querySelector('.save-state')?.textContent==='Saved')
 await until(()=>!button('Resume Backtest').matches(':disabled')); await click('Resume Backtest'); await until(()=>host.querySelector('.phase-trading')&&host.querySelector('.save-state')?.textContent==='Saved')
 expect(host.querySelector('[aria-label="Replay status"]')?.textContent).toBe('Paused')
 const resumed=(await disk.storage.list()).sessions[0]
 expect(resumed.id).toBe(before.id); expect(resumed.checkpoint.lifecycle).toBe('trading')
 expect(resumed.checkpoint.trading).toEqual(before.checkpoint.trading)
 expect(resumed.checkpoint.replay).toEqual(before.checkpoint.replay)
 expect(resumed.checkpoint.executionCursor).toBe(before.checkpoint.executionCursor)
 expect(resumed.checkpoint.equity).toEqual(before.checkpoint.equity)
 expect(resumed.checkpoint.workspace).toEqual(before.checkpoint.workspace)
 expect(equitySuffix((await store.recover(before.id,async()=>{throw Error('History download forbidden')})).ledger,0)).toEqual(equitySuffix(recovered.ledger,0))
 await act(async()=>root.unmount()); root=createRoot(host); await mount(); await click('Resume backtest')
 await until(()=>host.querySelector('.phase-trading'))
 expect(host.querySelector('[aria-label="Replay status"]')?.textContent).toBe('Paused')
 await order('Buy',1.098); await click('Next Min')
 const nextId=host.querySelector('[data-position-id]')!.getAttribute('data-position-id')!
 await click(`Close ${nextId}`); await click('Next Min')
 await click('Finish backtest'); await until(()=>host.querySelector('.phase-finished')&&host.querySelector('.save-state')?.textContent==='Saved')
 const after=(await disk.storage.list()).sessions[0]
 expect(after.checkpoint.trading.closed).toHaveLength(2)
 expect(after.checkpoint.trading.closed[0]).toEqual(before.checkpoint.trading.closed[0])
 expect(after.checkpoint.executionCursor).toBe(before.checkpoint.executionCursor+2)
 expect(after.checkpoint.equity.count).toBe(before.checkpoint.equity.count+2)
 const full=(await store.recover(before.id,async()=>{throw Error('History download forbidden')})).ledger
 expect(equitySuffix(full,0).slice(0,before.checkpoint.equity.count)).toEqual(equitySuffix(recovered.ledger,0))
 expect(host.querySelector('.results-sample')?.textContent).toContain('2 completed setups')
 expect(historyCalls).toBe(historyBefore); expect((await disk.storage.list()).sessions).toHaveLength(1)
})
it('resumes with open positions, pending orders, modified stops and independent chart preferences intact', async () => {
 await start(); await order('Buy',1.099); await click('Next Min')
 await dragStop(1.099,1.0995); await order('Buy',1.098)
 await act(async()=>host.querySelector<HTMLInputElement>('input[name="chart-count"][value="2"]')!.click())
 await select('Chart 1 timeframe','M5'); await select('Chart 2 timeframe','H1')
 const canvas=host.querySelector('.chart-canvas')!
 vi.spyOn(canvas,'getBoundingClientRect').mockReturnValue({left:0,top:0,width:900,height:650} as DOMRect)
 await act(async()=>{canvasWheel(canvas,200,-160)})
 await click('Finish backtest'); await until(()=>host.querySelector('.phase-finished')&&host.querySelector('.save-state')?.textContent==='Saved')
 const before=(await disk.storage.list()).sessions[0]
 expect(before.checkpoint.trading.positions).toHaveLength(1); expect(before.checkpoint.trading.pending).toHaveLength(1)
 expect(before.checkpoint.trading.positions[0].stopModifications).toHaveLength(1)
 await until(()=>!button('Resume Backtest').matches(':disabled')); await click('Resume Backtest'); await until(()=>host.querySelector('.phase-trading')&&host.querySelector('.save-state')?.textContent==='Saved')
 const after=(await disk.storage.list()).sessions[0]
 expect(after.checkpoint.trading).toEqual(before.checkpoint.trading); expect(after.checkpoint.equity).toEqual(before.checkpoint.equity)
 expect(after.checkpoint.executionCursor).toBe(before.checkpoint.executionCursor)
 expect(after.checkpoint.workspace).toEqual(before.checkpoint.workspace)
 expect([...host.querySelectorAll<HTMLSelectElement>('select[aria-label$="timeframe"]')].map(s=>s.value)).toEqual(['M5','H1'])
 await until(()=>!button('Next Min').matches(':disabled')); await click('Next Min'); await until(()=>host.querySelector('.save-state')?.textContent==='Saved')
 const advanced=(await disk.storage.list()).sessions[0]
 expect(advanced.checkpoint.trading.pending).toHaveLength(0); expect(advanced.checkpoint.trading.positions).toHaveLength(2)
 expect(advanced.checkpoint.executionCursor).toBe(before.checkpoint.executionCursor+1)
})
it('disables Results resume during saves and rolls back a failed lifecycle save without losing the checkpoint', async () => {
 await start(); await click('Finish backtest'); await until(()=>host.querySelector('.phase-finished')&&host.querySelector('.save-state')?.textContent==='Saved')
 const before=(await disk.storage.list()).sessions[0], underlying=globalThis.fetch
 let release!:()=>void
 vi.stubGlobal('fetch',async(path:string,options?:RequestInit)=>{
   if(path.includes('/checkpoint')&&typeof options?.body==='string') {
     const lifecycle=JSON.parse(options.body).record.checkpoint.lifecycle
     if(lifecycle==='finished'&&!release) await new Promise<void>(resolve=>{release=resolve})
     if(lifecycle==='trading') return new Response(JSON.stringify({error:'Disk write failed',code:'STORAGE_UNAVAILABLE'}),{status:503})
   }
   return underlying(path,options)
 })
 await click('Save now'); await until(()=>!!release)
 expect(button('Resume Backtest').disabled).toBe(true)
 await act(async()=>release()); await until(()=>host.querySelector('.save-state')?.textContent==='Saved')
 await until(()=>!button('Resume Backtest').matches(':disabled')); await click('Resume Backtest'); await until(()=>host.querySelector('.critical-save'))
 expect(host.querySelector('.phase-finished')).toBeTruthy(); expect(host.querySelector('.phase-trading')).toBeNull()
 const after=(await disk.storage.list()).sessions[0]
 expect(after.checkpoint).toEqual(before.checkpoint)
 vi.stubGlobal('fetch',underlying)
})
it('restores active sessions paused without drafts and keeps charts alive through next-candle updates',async()=>{
 await start();const count=vi.mocked(createChart).mock.calls.length;await order();await click('Next Min');expect(vi.mocked(createChart).mock.calls.length).toBe(count)
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
 expect(selectedRange('2024-01-10','2024-01-09',coverage).error).toBeTruthy();expect(selectedRange('2023-03-01','2024-02-29',coverage).error).toBeTruthy()
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
 for(let i=1;i<12;i++)await click('Next Min')
 expect(candlestick().at(-1).time).toBe(beginning/1000);expect(candlestick().at(-1).close).toBe(bid.at(-1)!.close);expect(host.querySelector('.phase-trading')).toBeTruthy();expect(button('Buy').disabled).toBe(true)
 await click('Review Results');await until(()=>host.querySelector('.phase-finished'));expect(host.querySelector('.results-primary')).toBeTruthy()
 await until(()=>host.querySelector('.save-state')?.textContent==='Saved')
 const before=(await disk.storage.list()).sessions[0]
 await until(()=>!button('Return to charts').matches(':disabled')); await click('Return to charts');await until(()=>host.querySelector('.phase-trading')&&host.querySelector('.save-state')?.textContent==='Saved')
 expect(button('Next Min').disabled).toBe(true);expect(button('Play').disabled).toBe(true);expect(button('Buy').disabled).toBe(true)
 await until(()=>!button('Review Results').matches(':disabled'));await click('Next Min');await click('Play');await click('Review Results');await until(()=>host.querySelector('.phase-finished')&&host.querySelector('.save-state')?.textContent==='Saved')
 const after=(await disk.storage.list()).sessions[0]
 expect(after.checkpoint).toEqual(before.checkpoint)
})

it('starts local mid-price history without pricing or confirmation and preserves the chosen name',async()=>{
 const underlying=globalThis.fetch,calls:string[]=[]
 vi.stubGlobal('fetch',async(path:string,options?:RequestInit)=>{
  calls.push(path)
  if(path.startsWith('/api/history?')) {
   const params=new URL(path,'http://local').searchParams
   return new Response(JSON.stringify({format:'local-forex-v1',source:'local-parquet',symbol:'EURUSD',resolution:'M1',datasetId:'a'.repeat(64),sourceChecksum:'a'.repeat(64),normalizationVersion:1,priceModel:'single',priceBasis:'mid',executionModel:'single-price-m1-v1',timestampConvention:'utc-minute-open',instrument:{symbol:'EURUSD',baseCurrency:'EUR',quoteCurrency:'USD',pipSize:.0001,priceDecimals:7,unitsPerLot:100000},from:params.get('from'),to:params.get('to'),candles:[...preroll,...bid]}))
  }
  return underlying(path,options)
 })
 await mount();await input('Backtest name','EURUSD mid research');await load()
 expect(host.querySelector('.header-session')?.textContent).toContain('EURUSD mid research')
 expect(host.querySelector('.pane-toolbar .instrument')?.textContent).toBe('EURUSDMid')
 expect(host.querySelector('.execution-details')?.textContent).toContain('EURUSD mid prices')
 expect(host.textContent).not.toContain('6E')
 expect(calls.some(path=>/estimate|download/.test(path))).toBe(false)
 await until(()=>host.querySelector('.save-state')?.textContent==='Saved')
 const record=(await disk.storage.list()).sessions[0]
 expect(record.symbol).toBe('EURUSD');expect(record.checkpoint.trading.executionModel).toBe('single-price-m1-v1')
 await act(async()=>root.unmount());root=createRoot(host);await mount();await click('Resume backtest');await until(()=>host.querySelector('.phase-trading'))
 expect(host.querySelector('.pane-toolbar .instrument')?.textContent).toBe('EURUSDMid')
 expect((await new DiskSessionStore().recover(record.id)).record.historyId).toBe(record.historyId)
})
it('formats chart prices to five decimals on every timeframe without rounding seven-decimal history', async () => {
 const underlying = globalThis.fetch
 const instrument = { symbol: 'EURUSD', baseCurrency: 'EUR', quoteCurrency: 'USD', pipSize: .0001, priceDecimals: 7, unitsPerLot: 100000 }
 const candles = [...preroll, ...bid].map(c => ({ ...c, open: 1.1000001, high: 1.1002007, low: 1.0999003, close: 1.1001009 }))
 const original = JSON.stringify({ instrument, candles })
 vi.stubGlobal('fetch', async (path: string, options?: RequestInit) => {
  if (!path.startsWith('/api/history?')) return underlying(path, options)
  const params = new URL(path, 'http://local').searchParams
  return new Response(JSON.stringify({ format: 'local-forex-v1', source: 'local-parquet', symbol: 'EURUSD', resolution: 'M1',
   datasetId: 'a'.repeat(64), sourceChecksum: 'a'.repeat(64), normalizationVersion: 1, priceModel: 'single', priceBasis: 'mid',
   executionModel: 'single-price-m1-v1', timestampConvention: 'utc-minute-open', instrument,
   from: params.get('from'), to: params.get('to'), candles }))
 })
 await start()
 for (const timeframe of VISIBLE_TIMEFRAMES) {
  await select('Chart 1 timeframe', timeframe)
  const canvas = host.querySelector('.chart-canvas')!, active = chartForCanvas(canvas)
  const index = vi.mocked(createChart).mock.calls.map(([element]) => element).lastIndexOf(canvas as HTMLElement)
  const format = vi.mocked(createChart).mock.calls[index][1]!.localization!.priceFormatter as (price: number) => string
  const series = vi.mocked(active.addSeries).mock.results[0].value
  expect(vi.mocked(active.addSeries).mock.calls[0][1]!.priceFormat).toEqual({ type: 'price', precision: 5, minMove: .00001 })
  // Axis ticks, current price, order/SL/TP price lines and crosshair labels all
  // share this chart formatter and the candle series' display price format.
  for (const [price, label] of [[1.1, '1.10000'], [1.1001009, '1.10010'], [1.1000001, '1.10000'], [1.0999003, '1.09990'], [1.1002007, '1.10020'], [1.1012345, '1.10123']] as const) {
   expect(format(price)).toBe(label)
  }
  expect(series.data().at(-1)).toMatchObject({ open: 1.1000001, high: 1.1002007, low: 1.0999003, close: 1.1001009 })
 }
 await until(() => host.querySelector('.save-state')?.textContent === 'Saved')
 const record = (await disk.storage.list()).sessions[0]
 const recovered = await new DiskSessionStore().recover(record.id)
 expect(isLocalForex(recovered.history)).toBe(true)
 if (!isLocalForex(recovered.history)) throw Error('Expected original local Forex history')
 expect(recovered.history.instrument).toEqual(instrument)
 expect(recovered.history.candles).toEqual(candles)
 expect(recovered.checkpoint.trading.quote).toMatchObject({ priceModel: 'single', trade: { open: 1.1000001, close: 1.1001009 } })
 expect(JSON.stringify({ instrument, candles })).toBe(original)
})
it('keeps out-of-coverage dates unavailable without requesting a download',async()=>{
 await mount();await input('From','2022-01-03');await input('Through','2022-01-04')
 expect(button('Start backtest').disabled).toBe(true)
 expect(host.textContent).toContain('replay days have missing or unverified local observations')
 expect(historyCalls).toBe(0);expect(host.textContent).not.toContain('Get more historical data')
})
it('shows an explicit empty local archive without offering online data',async()=>{
 const original=globalThis.fetch
 vi.stubGlobal('fetch',(path:string,options?:RequestInit)=>path==='/api/history/datasets'?Promise.resolve(new Response(JSON.stringify({datasets:[]}))):original(path,options))
 await mount();await until(()=>host.textContent?.includes('No local EURUSD history is installed'))
 expect(button('Start backtest').disabled).toBe(true);expect(historyCalls).toBe(0)
 expect(host.textContent).not.toMatch(/Databento|credits|paid/)
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
 await mount();await click(`Delete backtest ${host.querySelector('.saved-session-name')!.textContent}`);await click('Confirm delete');expect(localStorage.getItem(uiKey(record.id))).toBe('target')
 await act(async()=>release());await until(()=>!host.querySelector('.saved-session'))
 expect(localStorage.getItem(uiKey(record.id))).toBeNull();expect(localStorage.getItem(uiKey('other'))).toBe('keep')
})
it('keeps preferences when backend deletion fails', async()=>{
 vi.spyOn(PreferenceTabGuard.prototype,'exclusive').mockImplementation(operation=>operation())
 const record=await seedSaved();localStorage.setItem(uiKey(record.id),'keep')
 const underlying=globalThis.fetch
 vi.stubGlobal('fetch',(path:string,options?:RequestInit)=>options?.method==='DELETE'?Promise.resolve(new Response(JSON.stringify({error:'Deletion failed'}),{status:503})):underlying(path,options))
 await mount();await click(`Delete backtest ${host.querySelector('.saved-session-name')!.textContent}`);await click('Confirm delete');await until(()=>host.textContent?.includes('Deletion failed'))
 expect(localStorage.getItem(uiKey(record.id))).toBe('keep');expect((await disk.storage.list()).sessions).toHaveLength(1)
})
it('keeps preferences shared with a retained legacy original after successful disk deletion', async()=>{
 vi.spyOn(PreferenceTabGuard.prototype,'exclusive').mockImplementation(operation=>operation())
 const original=await seedSaved('Browser original',true),store=new DiskSessionStore(),legacy=new SessionStore()
 await store.migrate(legacy,original.id,async()=>{throw new Error('No download allowed')});await legacy.close()
 localStorage.setItem(uiKey(original.id),'keep');await mount();await click(`Delete backtest ${host.querySelector('.saved-session-name')!.textContent}`);await click('Confirm delete');await until(()=>!host.querySelector('.saved-session'))
 expect(localStorage.getItem(uiKey(original.id))).toBe('keep');expect((await disk.storage.list()).sessions).toHaveLength(0)
})
it('keeps successful backtest deletion successful if Local Storage removal throws',async()=>{
 vi.spyOn(PreferenceTabGuard.prototype,'exclusive').mockImplementation(operation=>operation())
 const record=await seedSaved();localStorage.setItem(uiKey(record.id),'keep')
 vi.spyOn(Storage.prototype,'removeItem').mockImplementation(()=>{throw new Error('denied')})
 await mount();await click(`Delete backtest ${host.querySelector('.saved-session-name')!.textContent}`);await click('Confirm delete');await until(()=>!host.querySelector('.saved-session'))
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
 await act(async()=>host.querySelector<HTMLElement>('.storage-maintenance > summary')!.click())
 expect(host.querySelector<HTMLDetailsElement>('.storage-maintenance')!.open).toBe(true)
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
 await act(async()=>host.querySelector<HTMLElement>('.storage-maintenance > summary')!.click())
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
  if(path.startsWith('/api/history/calendar')){
   const calendar=await (await underlying(path,options)).json()
   const bar={...bid[0],timestamp:Date.parse('2024-01-10')}
   calendar.days.push({date:'2024-01-10',status:'cached',observations:1,h4:[bar]})
   return new Response(JSON.stringify(calendar))
  }
  if(path.startsWith('/api/history?')){
   const params=new URL(path,'http://local').searchParams
   const source=fixtureHistory(params.get('from')!,params.get('to')!,'2024-01-10')
   source.candles=[...preroll,...bid.slice(0,2),{...bid[0],timestamp:Date.parse('2024-01-10')}].map(bar=>({...bar,volume:'1',instrumentId:bar.timestamp<Date.parse('2024-01-10')?101:202}))
   return new Response(JSON.stringify(source))
  }
  return underlying(path,options)
 })
 await mount();await input('Through','2024-01-10');await load();await click('Next Min')
 expect(host.querySelector('[aria-label="Replay status"]')?.textContent).toBe('Rollover blocked')
 expect(button('Next Min').disabled).toBe(true);expect(button('Play').disabled).toBe(true)
 expect((await shortcut('ArrowRight',window,true)).defaultPrevented).toBe(false)
 expect(host.querySelector('.replay-clock')?.textContent).toContain('00:01')
 await until(()=>host.querySelector('.save-state')?.textContent==='Saved');expect((await disk.storage.list()).sessions[0].checkpoint.replay.timestamp).toBe(beginning+60000)
 await click('Review Results');await until(()=>host.querySelector('.phase-finished')&&host.querySelector('.save-state')?.textContent==='Saved')
 const before=(await disk.storage.list()).sessions[0]
 await until(()=>!button('Return to charts').matches(':disabled')); await click('Return to charts');await until(()=>host.querySelector('.phase-trading')&&host.querySelector('.save-state')?.textContent==='Saved')
 expect(host.querySelector('[aria-label="Replay status"]')?.textContent).toBe('Rollover blocked')
 expect(button('Next Min').disabled).toBe(true);expect(button('Play').disabled).toBe(true);expect(button('Buy').disabled).toBe(true)
 await until(()=>!button('Review Results').matches(':disabled'));await click('Next Min');await click('Play');await click('Review Results');await until(()=>host.querySelector('.phase-finished')&&host.querySelector('.save-state')?.textContent==='Saved')
 expect((await disk.storage.list()).sessions[0].checkpoint).toEqual(before.checkpoint)
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
 await click('Next Min'); expect(activeStopLines()).toEqual([line]); expect(line.options()).toMatchObject({ lineStyle: 0 })
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
 await click('Next Min'); expect(activeStopLines()).toHaveLength(1)
 expect(host.querySelectorAll('[data-position-id]')).toHaveLength(1)
 expect(host.querySelector('[data-position-id]')?.textContent).toMatch(/^B2.*lotsEst. net.*Close$/)
})
it('keeps SL 2 after SL 1 closes and after restoring the existing checkpoint format', async () => {
 await start(); await order('Buy', 1.099); await order('Buy', 1.098); await click('Next Min')
 const [first, second] = [...host.querySelectorAll('[data-position-id]')].map(row => row.getAttribute('data-position-id')!)
 await click(`Close ${first}`); await click('Next Min')
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
 await click('Next Min'); expect(activeStopLines()).toHaveLength(0)
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
it('keeps drafts uncommitted until toolbar confirmation, without an on-chart button, and retains cancellation and validation', async () => {
 await start(); await click('Buy'); await pick(1.099)
 const annotation = host.querySelector('.draft-stop-annotation')!
 expect(annotation.textContent).toContain('Draft SL · 13.0 pips')
 expect(annotation.querySelector('button')).toBeNull()
 expect(host.querySelector('.confirm-draft-stop')).toBeNull()
 expect(host.querySelector('[aria-label="Confirm draft stop-loss"]')).toBeNull()
 expect(host.querySelector('[data-order-id]')).toBeNull()
 const toolbarConfirm = button('Confirm order')
 await act(async () => { toolbarConfirm.click(); toolbarConfirm.click() })
 expect(host.querySelectorAll('[data-order-id]')).toHaveLength(1)
 expect(host.querySelector('.draft-stop-annotation')).toBeNull()
 await click('Buy'); await pick(1.2)
 expect(host.querySelector('.draft-stop-annotation')?.textContent).toContain('Invalid SL side')
 expect(button('Confirm order').disabled).toBe(true)
 expect((await tradeKey('b')).defaultPrevented).toBe(false)
 await click('Confirm order'); expect(host.querySelectorAll('[data-order-id]')).toHaveLength(1)
 await act(async () => window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})))
 expect(host.querySelector('.draft-stop-annotation')).toBeNull()
})
it.each([['Buy', 1.099, 1.104, 1.098, 'b'], ['Sell', 1.103, 1.096, 1.104, 's']] as const)('drags the %s draft annotation without confirming and validates the result before keyboard confirmation', async (direction, initial, invalid, valid, key) => {
 await start(); await click(direction); await pick(initial)
 const canvas = host.querySelector<HTMLElement>('.chart-canvas')!, plot = canvas.parentElement!
 const series = vi.mocked(chartForCanvas(canvas).addSeries).mock.results[0].value as ISeriesApi<'Candlestick'>
 vi.spyOn(series, 'priceToCoordinate').mockImplementation((price: number) => (1.2 - price) * 1000 as ReturnType<typeof series.priceToCoordinate>)
 vi.spyOn(series, 'coordinateToPrice').mockImplementation((y: number) => 1.2 - y / 1000 as ReturnType<typeof series.coordinateToPrice>)
 vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 800, height: 500 } as DOMRect)
 Object.assign(plot, { setPointerCapture: vi.fn(), hasPointerCapture: () => false, releasePointerCapture: vi.fn() })
 const annotation = host.querySelector<HTMLElement>('.draft-stop-annotation')!
 const pointer = (type: string, price: number, target: Element = plot) => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 80, clientY: (1.2 - price) * 1000, button: 0 })
  Object.defineProperty(event, 'pointerId', { value: 1 }); target.dispatchEvent(event)
 }
 await act(async () => annotation.click())
 expect(host.querySelector('[data-order-id]')).toBeNull()
 for (const [from, to] of [[initial, invalid], [invalid, valid]]) {
  await act(async () => { pointer('pointerdown', from, annotation.querySelector('span')!); pointer('pointermove', to) })
  expect(host.querySelector('[data-order-id]')).toBeNull()
  await act(async () => pointer('pointerup', to))
  expect(host.querySelector('.stop-placement')?.textContent).toContain(`SL ${to.toFixed(5)}`)
  expect(host.querySelector('[data-order-id]')).toBeNull()
  expect(annotation.querySelector('button')).toBeNull()
  if (to === invalid) {
   expect(annotation.textContent).toContain('Invalid SL side')
   expect(annotation.dataset.invalid).toBe('true')
   expect(button('Confirm order').disabled).toBe(true)
   expect((await tradeKey(key)).defaultPrevented).toBe(false)
   await click('Confirm order'); expect(host.querySelector('[data-order-id]')).toBeNull()
  }
 }
 expect(annotation.textContent).toContain('Draft SL · ')
 expect(annotation.textContent).not.toContain('Invalid SL side')
 expect((await tradeKey(key)).defaultPrevented).toBe(true)
 expect(host.querySelectorAll('[data-order-id]')).toHaveLength(1)
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
 await click('Next Min')
 expect(activeEntryLines().map(line=>line.options())).toMatchObject([{title:'B1 · B2',price:1.1003,lineStyle:2}])
 await until(()=>host.querySelector('.save-state')?.textContent==='Saved')
 const before=(await disk.storage.list()).sessions[0].checkpoint.trading
 await act(async()=>root.unmount());root=createRoot(host);await mount();await click('Resume backtest');await until(()=>host.querySelector('.phase-trading'))
 expect(activeEntryLines()[0].options().title).toBe('B1 · B2')
 expect(activeEntryLines()[0].options().price).toBe(before.positions[0].entryPrice)
 const first=before.positions[0].id
 await click(`Close ${first}`);await click('Next Min')
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

async function shortcut(key: 'ArrowLeft' | 'ArrowRight', target: EventTarget = window, ctrlKey = false) {
 const event = new KeyboardEvent('keydown', { key, shiftKey: true, ctrlKey, bubbles: true, cancelable: true })
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
 await click('Next Min')
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
it.each([false,true])('blocks replay shortcuts in editors, overlays, drafts and playback with Ctrl=%s', async ctrlKey => {
 await start(); const clock = () => host.querySelector('time')?.textContent
 const before = clock(), risk = host.querySelector<HTMLInputElement>('[aria-label="Risk per entry (%)"]')!
 for (const element of [risk, host.querySelector('select')!, document.createElement('textarea'), document.createElement('div')]) {
  if (!element.isConnected) { host.append(element); element.setAttribute('contenteditable', 'true') }
  await act(async () => (element as HTMLElement).focus())
  expect((await shortcut('ArrowRight', element, ctrlKey)).defaultPrevented).toBe(false); expect(clock()).toBe(before)
  ;(element as HTMLElement).blur()
 }
 for (const selector of ['.execution-details', '.indicator-controls']) {
  await act(async () => { host.querySelector<HTMLDetailsElement>(selector)!.open = true })
  expect((await shortcut('ArrowRight', window, ctrlKey)).defaultPrevented).toBe(false); expect(clock()).toBe(before)
  await act(async () => host.querySelector<HTMLDetailsElement>(selector)!.open = false)
 }
 await click('Sessions / settings'); expect((await shortcut('ArrowRight', window, ctrlKey)).defaultPrevented).toBe(false); await click('Close management')
 await click('Buy'); expect((await shortcut('ArrowRight', window, ctrlKey)).defaultPrevented).toBe(false); await click('Cancel placement')
 await click('Play'); expect((await shortcut('ArrowRight', window, ctrlKey)).defaultPrevented).toBe(false)
 expect(host.querySelector('.keyboard-notice')?.textContent).toContain('Pause replay')
 await click('Pause'); expect(clock()).toBe(before)
 expect(host.querySelector('.keyboard-notice')).toBeNull()
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
 for (const name of ['Play', 'Pause', 'Next Min', 'Finish backtest']) {
  expect(header.contains(button(name))).toBe(true)
  expect([...host.querySelectorAll('button')].filter(b => b.textContent === name)).toHaveLength(1)
 }
 expect(header.querySelector('[aria-label="Replay speed"]')).not.toBeNull()
 expect(header.querySelectorAll('input[name="chart-count"]')).toHaveLength(4)
 expect(header.querySelector('[aria-label="Replay status"]')).not.toBeNull()
 expect(header.querySelector('[aria-label="Replay progress"]')).not.toBeNull()
 for (const name of ['Buy', 'Sell']) expect(toolbar.contains(button(name))).toBe(true)
 expect(toolbar.querySelector('[aria-label="Risk per entry (%)"]')).not.toBeNull()
 expect(toolbar.querySelector('.header-replay')).toBeNull()
 await click('Play')
 expect(button('Play').matches(':disabled')).toBe(true)
 expect(button('Next Min').matches(':disabled')).toBe(true)
 expect(button('Pause').matches(':disabled')).toBe(false)
 await click('Pause'); await click('Sessions / settings')
 for (const control of header.querySelectorAll('.header-replay button, .header-replay select, .header-replay input')) expect(control.matches(':disabled')).toBe(true)
 await click('Close management')
 expect(button('Next Min').matches(':disabled')).toBe(false)
 await shortcut('ArrowLeft')
 expect(button('Play').matches(':disabled')).toBe(true)
 expect(button('Next Min').matches(':disabled')).toBe(true)
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
 expect(status().textContent).toContain('Indicators ready')
 await select('Chart 1 timeframe', 'M5')
 await input('Chart 1 Span B', '1'); await input('Chart 1 Kijun', '1'); await input('Chart 1 Tenkan', '1'); await input('Chart 1 Displacement', '1')
 await input('Chart 1 BB #1 Length', '79')
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
 expect(button('Next Min').matches(':disabled')).toBe(false)
 let release!: () => void
 guards = { flush: () => new Promise<void>(resolve => { release = resolve }) }
 await act(async () => root.render(<StrictMode><App/></StrictMode>))
 await click('Finish backtest')
 for (const control of host.querySelectorAll('.header-replay button, .header-replay select, .header-replay input')) expect(control.matches(':disabled')).toBe(true)
 vi.mocked(window.confirm).mockReturnValueOnce(false)
 await act(async () => release())
 expect(button('Next Min').matches(':disabled')).toBe(false)
})

it('keeps pending, mixed and two open records inside the entry row with full accessible IDs and working actions', async () => {
 await start(); await order('Buy', 1.099)
 const strip = () => host.querySelector('.dock-controls .active-positions')!
 expect(strip().getAttribute('tabindex')).toBe('0')
 expect(strip().querySelectorAll('[data-order-id]')).toHaveLength(1)
 await click('Next Min')
 expect(strip().querySelectorAll('[data-position-id]')).toHaveLength(1)
 await order('Buy', 1.098)
 expect(strip().querySelectorAll('[data-position-id]')).toHaveLength(1)
 expect(strip().querySelectorAll('[data-order-id]')).toHaveLength(1)
 await click('Next Min')
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
 await click(`Close ${first}`); await click('Next Min')
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

async function tradeKey(key = 'b', target: EventTarget = window, init: KeyboardEventInit = {}) {
 const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
 await act(async () => target.dispatchEvent(event))
 return event
}
it.each(['b', 's'])('confirms initial and second %s entries through the existing SL workflow, preserving risk and enforcing setup limits', async key => {
 await start(); await input('Risk per entry (%)', '.4')
 const stop = key === 'b' ? 1.097 : 1.103
 expect((await tradeKey(key)).defaultPrevented).toBe(true)
 expect(host.querySelector('.stop-placement')?.textContent).toContain(`${key === 'b' ? 'Buy' : 'Sell'} · slot 1`)
 expect(host.querySelector('.active-positions')).toBeNull()
 await pick(stop)
 expect(host.querySelector('.active-positions')).toBeNull()
 expect((await tradeKey(key)).defaultPrevented).toBe(true)
 expect(host.querySelector('.active-positions')?.textContent).toContain('0.4% risk')
 const other = key === 'b' ? 's' : 'b'
 expect((await tradeKey(other)).defaultPrevented).toBe(false)
 await click('Next Min')
 await input('Risk per entry (%)', '.2')
 expect((await tradeKey(key.toUpperCase())).defaultPrevented).toBe(true)
 expect(host.querySelector('.stop-placement')?.textContent).toContain('slot 2')
 await pick(stop); await click('Confirm order')
 expect(host.querySelector('.active-positions')?.textContent).toContain('0.2% risk')
 for (const letter of ['b', 's']) expect((await tradeKey(letter)).defaultPrevented).toBe(false)
 await click('Next Min'); await until(() => host.querySelector('.save-state')?.textContent === 'Saved')
 const state = (await disk.storage.list()).sessions[0].checkpoint.trading
 expect(state.pending).toHaveLength(0); expect(state.positions).toHaveLength(2)
 expect(state.setups).toHaveLength(1)
 expect(state.positions[0].setupId).toBe(state.positions[1].setupId)
 expect(state.positions.map(p => p.requestedRiskPercent)).toEqual([.4, .2])
})
it('blocks trade keys for editing, panels, playback, historical review, draft placement, dragging, and finished lifecycle', async () => {
 await mount(); expect((await tradeKey()).defaultPrevented).toBe(false); await load()
 const risk = host.querySelector<HTMLInputElement>('[aria-label="Risk per entry (%)"]')!
 risk.focus(); expect((await tradeKey()).defaultPrevented).toBe(false); risk.blur()
 for (const selector of ['.indicator-controls', '.execution-details']) {
  const panel = host.querySelector<HTMLDetailsElement>(selector)!
  await act(async () => { panel.open = true })
  expect((await tradeKey()).defaultPrevented).toBe(false)
  await act(async () => { panel.open = false })
 }
 await click('Sessions / settings'); expect((await tradeKey()).defaultPrevented).toBe(false); await click('Close management')
 await click('Play'); expect((await tradeKey()).defaultPrevented).toBe(false); await click('Pause')
 await tradeKey('b'); await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
 expect(host.querySelector('.stop-placement')).toBeNull()
 await select('Chart 1 timeframe', 'M5')
 await order('Buy', 1.097)
 expect(host.querySelectorAll('.active-positions [data-order-id]'), host.textContent!).toHaveLength(1)
 expect((await shortcut('ArrowRight')).defaultPrevented, host.textContent!).toBe(true)
 expect(host.querySelectorAll('.active-positions [data-position-id]'), host.textContent!).toHaveLength(1)
 await shortcut('ArrowLeft')
 expect(host.querySelector('.history-review')).not.toBeNull()
 expect((await tradeKey()).defaultPrevented).toBe(false)
 await click('Return to current replay')
 expect(host.querySelectorAll('.active-positions [data-position-id]')).toHaveLength(1)
 expect(button('Buy').matches(':disabled')).toBe(false)
 const canvas = host.querySelector<HTMLElement>('.chart-canvas')!, series = chartForCanvas(canvas).addSeries.mock.results[0].value as ISeriesApi<'Candlestick'>
 vi.spyOn(series, 'priceToCoordinate').mockReturnValue(100 as ReturnType<typeof series.priceToCoordinate>)
 vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 800, height: 500 } as DOMRect)
 Object.assign(canvas, { setPointerCapture: () => {}, hasPointerCapture: () => false, releasePointerCapture: () => {} })
 const pointer = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 80, clientY: 100, button: 0 })
 Object.defineProperty(pointer, 'pointerId', { value: 1 })
 await act(async () => canvas.dispatchEvent(pointer))
 expect(host.querySelector('.stop-drag-status')).not.toBeNull()
 expect((await tradeKey()).defaultPrevented).toBe(false)
 await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
 expect(host.querySelector('.stop-drag-status')).toBeNull()
 await click('Finish backtest'); await until(() => host.querySelector('.phase-finished'))
 expect((await tradeKey()).defaultPrevented).toBe(false)
})
it('trade shortcuts respect every session guard and an outstanding finish confirmation', async () => {
 await start()
 const original = persistence.useSessionPersistence
 let guards: Partial<ReturnType<typeof original>> = {}
 vi.spyOn(persistence, 'useSessionPersistence').mockImplementation(options => ({ ...original(options), ...guards }))
 for (const guard of [{ initialized: false }, { busy: true }, { conflict: true }, { awaitingChoice: true }]) {
  guards = guard; await act(async () => root.render(<StrictMode><App/></StrictMode>))
  for (const key of ['b', 's']) expect((await tradeKey(key)).defaultPrevented).toBe(false)
  expect(host.querySelector('.stop-placement')).toBeNull()
 }
 let release!: () => void
 guards = { flush: () => new Promise<void>(resolve => { release = resolve }) }
 await act(async () => root.render(<StrictMode><App/></StrictMode>))
 await click('Finish backtest'); expect((await tradeKey()).defaultPrevented).toBe(false)
 vi.mocked(window.confirm).mockReturnValueOnce(false)
 await act(async () => release())
 expect((await tradeKey()).defaultPrevented).toBe(true)
})
it('updates individual and combined net PnL through quotes, close, journal and saved-session restoration', async () => {
 await start(); await order('Buy', 1.097); await click('Next Min')
 await order('Buy', 1.096); await click('Next Min')
 const total = () => host.querySelector('.open-total strong')!.textContent
 const firstTotal = total()
 await click('Next Min'); expect(total()).not.toBe(firstTotal)
 await until(() => host.querySelector('.save-state')?.textContent === 'Saved')
 let saved = (await disk.storage.list()).sessions[0], state = saved.checkpoint.trading
 const first = state.positions[0].id
 const accountBefore = host.querySelector('[aria-label="Account PnL"]')!.textContent
 expect(combinedOpenPnl(state)!.estimatedNetPnlUsd).toBeCloseTo(state.positions.reduce((sum, p) => sum + markPosition(p, state.quote)!.estimatedNetPnlUsd, 0), 10)
 await click(`Close ${first}`); await click('Next Min'); await until(() => host.querySelector('.save-state')?.textContent === 'Saved')
 saved = (await disk.storage.list()).sessions[0]; state = saved.checkpoint.trading
 expect(state.closed).toHaveLength(1); expect(state.positions).toHaveLength(1)
 const individual = host.querySelector('.active-positions [data-position-id] span.positive, .active-positions [data-position-id] span.negative')!.textContent!
 expect(individual.replace('Est. net ', '')).toBe(total())
 expect(host.querySelector('[aria-label="Account PnL"]')!.textContent).not.toBe(accountBefore)
 const expectedTotal = total(), account = host.querySelector('[aria-label="Account PnL"]')!.textContent
 await act(async () => root.unmount()); root = createRoot(host); await mount(); await click('Resume backtest'); await until(() => host.querySelector('.phase-trading'))
 expect(total()).toBe(expectedTotal)
 expect(host.querySelector('[aria-label="Account PnL"]')!.textContent).toBe(account)
 await click('Finish backtest'); await until(() => host.querySelector('.phase-finished'))
 await until(() => !host.querySelector<HTMLFieldSetElement>('.workspace-controls')!.disabled)
 await act(async () => { host.querySelector<HTMLDetailsElement>('.results-breakdown')!.open = true })
 for (const toggle of host.querySelectorAll<HTMLButtonElement>('.results-breakdown button[aria-expanded]')) await act(async () => toggle.click())
 expect(host.querySelector('.results-breakdown')!.textContent).toContain(first)
 await until(() => host.querySelector('.save-state')?.textContent === 'Saved')
})

it('renames from the saved label with explicit confirmation, keyboard cancel, validation and durable identity', async () => {
 const record = await seedSaved('Original name')
 await mount()
 expect(host.textContent).not.toContain('Manage backtest')
 await click('Rename backtest Original name')
 const editor = () => host.querySelector<HTMLInputElement>(`[aria-label="Rename session ${record.id}"]`)!
 expect(document.activeElement).toBe(editor())
 expect(editor().selectionStart).toBe(0); expect(editor().selectionEnd).toBe('Original name'.length)
 await input(`Rename session ${record.id}`, '   ')
 expect(button('Confirm rename').disabled).toBe(true)
 await act(async () => editor().closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
 expect((await disk.storage.list()).sessions[0].name).toBe('Original name')
 await input(`Rename session ${record.id}`, 'Discarded')
 await act(async () => editor().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
 expect(editor()).toBeNull(); expect(document.activeElement).toBe(button('Rename backtest Original name'))
 await click('Rename backtest Original name'); await input(`Rename session ${record.id}`, 'Also discarded'); await click('Cancel rename')
 expect(document.activeElement).toBe(button('Rename backtest Original name'))
 await click('Rename backtest Original name'); await input(`Rename session ${record.id}`, '  Renamed research  ')
 expect((await disk.storage.list()).sessions[0].name).toBe('Original name')
 await act(async () => editor().closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
 await until(() => host.querySelector('.saved-session-name')?.textContent === 'Renamed research')
 expect(document.activeElement).toBe(button('Rename backtest Renamed research'))
 const renamed = (await disk.storage.list()).sessions[0]
 expect(renamed.id).toBe(record.id); expect(renamed.name).toBe('Renamed research')
 expect(renamed.checkpoint).toEqual(record.checkpoint); expect(renamed.historyId).toBe(record.historyId)
})
it('confirms trash deletion separately, cancels with button or Escape, and restores focus', async () => {
 vi.spyOn(PreferenceTabGuard.prototype,'exclusive').mockImplementation(operation=>operation())
 const record = await seedSaved('Delete test')
 await mount(); await click('Delete backtest Delete test')
 expect(host.querySelector('[aria-label="Delete backtest confirmation"]')?.textContent).toContain('local storage on this computer')
 expect(host.textContent).toContain('“Delete test”')
 expect(document.activeElement).toBe(button('Cancel delete'))
 expect((await disk.storage.list()).sessions).toHaveLength(1)
 await click('Cancel delete'); expect(document.activeElement).toBe(button('Delete backtest Delete test'))
 await click('Delete backtest Delete test')
 await act(async () => button('Cancel delete').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
 expect(document.activeElement).toBe(button('Delete backtest Delete test'))
 expect((await disk.storage.list()).sessions[0].id).toBe(record.id)
 await click('Delete backtest Delete test'); await click('Confirm delete')
 await until(() => !host.querySelector('.saved-session'))
 expect((await disk.storage.list()).sessions).toHaveLength(0)
 await until(() => document.activeElement === button('New backtest'))
 expect(window.confirm).not.toHaveBeenCalled()
})
it('keeps placement guidance, draft estimate, keyboard price and confirmation inside the main toolbar', async () => {
 await start(); await tradeKey('s')
 const region = () => host.querySelector('.stop-placement')!
 expect(region().parentElement).toBe(host.querySelector('.dock-controls'))
 expect(host.querySelector('.workspace-toolbar > .stop-placement')).toBeNull()
 expect(region().textContent).toContain('Click the price chart')
 const keyboard = region().querySelector<HTMLDetailsElement>('details')!
 await act(async () => { keyboard.open = true })
 await input('SL price', '1.103')
 expect(region().textContent).toContain('SL 1.10300'); expect(region().textContent).toContain('Observed-price estimate')
 expect(button('Confirm order').disabled).toBe(false)
 await click('Cancel placement'); expect(host.querySelector('.stop-placement')).toBeNull()
 await tradeKey('s'); await pick(1.103); await click('Confirm order')
 expect(host.querySelector('.stop-placement')).toBeNull()
 expect(host.querySelector('.active-positions')?.textContent).toContain('Pending S1')
})
it('Close all queues both exits, preserves net commissions and journal/account data through reload', async () => {
 await start()
 expect(host.querySelector('.close-all')).toBeNull()
 await order('Buy', 1.097); expect(host.querySelector('.close-all')).toBeNull(); await click('Next Min')
 await order('Buy', 1.096); await click('Next Min')
 expect(button('Close all').disabled).toBe(false)
 await until(() => host.querySelector('.save-state')?.textContent === 'Saved')
 const before = (await disk.storage.list()).sessions[0].checkpoint.trading
 const confirmations = vi.mocked(window.confirm).mock.calls.length
 await click('Close all'); expect(button('Close all').disabled).toBe(true)
 expect(host.querySelectorAll('.active-positions [data-position-id]')).toHaveLength(2)
 expect(host.querySelector('.open-total')).not.toBeNull()
 expect(vi.mocked(window.confirm).mock.calls).toHaveLength(confirmations)
 await click('Next Min'); await until(() => host.querySelector('.save-state')?.textContent === 'Saved')
 const saved = (await disk.storage.list()).sessions[0], state = saved.checkpoint.trading
 expect(state.positions).toHaveLength(0); expect(state.closed).toHaveLength(2)
 expect(state.closed.map(p => p.id)).toEqual(before.positions.map(p => p.id))
 expect(state.setups).toHaveLength(1)
 for (const closed of state.closed) expect(closed.netPnlUsd).toBeCloseTo(closed.grossPnlUsd - closed.entryCommissionUsd - closed.exitCommissionUsd, 10)
 expect(host.querySelector('.open-total')).toBeNull(); expect(host.querySelector('.close-all')).toBeNull()
 const account = host.querySelector('[aria-label="Account PnL"]')!.textContent
 await act(async () => root.unmount()); root = createRoot(host); await mount(); await click('Resume backtest'); await until(() => host.querySelector('.phase-trading'))
 expect(host.querySelector('[aria-label="Account PnL"]')!.textContent).toBe(account)
 await until(() => host.querySelector('.save-state')?.textContent === 'Saved')
 expect((await disk.storage.list()).sessions[0].checkpoint.trading).toEqual(state)
 await click('Finish backtest'); await until(() => host.querySelector('.phase-finished'))
 await until(() => !host.querySelector<HTMLFieldSetElement>('.workspace-controls')!.disabled)
 await act(async () => { host.querySelector<HTMLDetailsElement>('.results-breakdown')!.open = true })
 for (const toggle of host.querySelectorAll<HTMLButtonElement>('.results-breakdown button[aria-expanded]')) await act(async () => toggle.click())
 for (const position of state.closed) expect(host.querySelector('.results-breakdown')!.textContent).toContain(position.id)
})
it('Close all leaves a pending entry intact and obeys playback and review constraints', async () => {
 await start(); await order('Buy', 1.097); await click('Next Min'); await order('Buy', 1.096)
 await until(() => host.querySelector('.save-state')?.textContent === 'Saved')
 const before = (await disk.storage.list()).sessions[0].checkpoint.trading
 await click('Play'); expect(button('Close all').disabled).toBe(true); await click('Pause')
 await shortcut('ArrowLeft'); expect(host.querySelector('.close-all')).toBeNull(); await click('Return to current replay')
 await click('Close all'); await until(() => host.querySelector('.save-state')?.textContent === 'Saved')
 const queued = (await disk.storage.list()).sessions[0].checkpoint.trading
 expect(queued.pending).toEqual(before.pending); expect(queued.positions[0].closeRequestedAt).not.toBeNull()
 expect(host.querySelector('.active-positions [data-order-id] button')?.getAttribute('aria-label')).toBe(`Cancel entry ${before.pending[0].id}`)
})
it('focuses the surviving saved label after deleting another backtest', async () => {
 vi.spyOn(PreferenceTabGuard.prototype,'exclusive').mockImplementation(operation=>operation())
 await seedSaved('Keep this one'); await seedSaved('Remove this one')
 await mount(); await click('Delete backtest Remove this one'); await click('Confirm delete')
 await until(() => host.querySelectorAll('.saved-session').length === 1)
 await until(() => document.activeElement === button('Rename backtest Keep this one'))
 expect((await disk.storage.list()).sessions[0].name).toBe('Keep this one')
})

it.each([['Buy', 1.097, 'B'], ['Sell', 1.103, 'S']] as const)('directional key starts and confirms a selected %s draft exactly once', async (direction, price, identity) => {
 await start(); await tradeKey(identity.toLowerCase()); await pick(price)
 expect(host.querySelector('.stop-placement')?.textContent).toContain(`${identity} to confirm · Esc to cancel`)
 for (const key of [identity === 'B' ? 's' : 'b', 'Enter']) {
  expect((await tradeKey(key)).defaultPrevented).toBe(false)
  expect(host.querySelector('[data-order-id]')).toBeNull()
  expect(host.querySelector('.stop-placement')).not.toBeNull()
 }
 expect(host.querySelector('.draft-stop-annotation button')).toBeNull()
 expect(host.querySelector('[data-order-id]')).toBeNull()
 const confirm = button('Confirm order')
 const first = new KeyboardEvent('keydown', { key: identity, bubbles: true, cancelable: true })
 await act(async () => {
  window.dispatchEvent(first)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: identity, cancelable: true }))
  window.dispatchEvent(new KeyboardEvent('keydown', { key: identity, repeat: true, cancelable: true }))
  confirm.click()
 })
 expect(first.defaultPrevented).toBe(true)
 expect(host.querySelectorAll('[data-order-id]')).toHaveLength(1)
 expect(host.querySelector('.active-positions')?.textContent).toContain(`Pending ${identity}1`)
 expect((await tradeKey('Enter')).defaultPrevented).toBe(false)
 await click(direction); await pick(price)
 for (let i = 0; i < 3; i++) expect((await tradeKey(identity, window, { repeat: true })).defaultPrevented).toBe(false)
 expect(host.querySelectorAll('[data-order-id]')).toHaveLength(1)
 await tradeKey('Escape'); expect(host.querySelector('.stop-placement')).toBeNull()
 await click('Next Min')
 expect(host.querySelectorAll('[data-position-id]')).toHaveLength(1)
})
it.each([['Buy', 'b', '1.2', '1.097'], ['Sell', 's', '1', '1.103']] as const)('%s confirms from the dedicated numeric SL input, but leaves missing and invalid prices alone', async (direction, key, invalid, valid) => {
 await start(); await tradeKey(key)
 const details = host.querySelector<HTMLDetailsElement>('.stop-placement details')!
 await act(async () => { details.open = true })
 const price = host.querySelector<HTMLInputElement>('[aria-label="SL price"]')!
 price.focus()
 for (const value of ['', '0', '-1', invalid]) {
  await input('SL price', value)
  expect((await tradeKey(key, price)).defaultPrevented).toBe(false)
  expect(host.querySelector('[data-order-id]')).toBeNull()
 }
 await input('SL price', valid)
 expect((await tradeKey('Enter', price)).defaultPrevented).toBe(false)
 expect(host.querySelector('[data-order-id]')).toBeNull()
 expect((await tradeKey(key, price)).defaultPrevented).toBe(true)
 expect(host.querySelectorAll('[data-order-id]')).toHaveLength(1)
})
it('ignores modified, repeated, composing and prevented B/S and preserves unrelated shortcuts', async () => {
 await start(); await click('Buy'); await pick(1.097)
 for (const init of [{ repeat: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }]) {
  expect((await tradeKey('b', window, init)).defaultPrevented).toBe(false)
 }
 const prevented = new KeyboardEvent('keydown', { key: 'b', cancelable: true })
 prevented.preventDefault(); await act(async () => window.dispatchEvent(prevented))
 for (const key of ['Enter', 's', 'ArrowRight', ' ']) expect((await tradeKey(key)).defaultPrevented).toBe(false)
 expect(host.querySelector('[data-order-id]')).toBeNull()
 expect((await tradeKey('b')).defaultPrevented).toBe(true)
 expect(host.querySelectorAll('[data-order-id]')).toHaveLength(1)
})
it('preserves native Enter on Cancel, Confirm and other interactive elements', async () => {
 await start(); await click('Buy'); await pick(1.097)
 for (const name of ['Cancel placement', 'Confirm order', 'Sessions / settings']) {
  const control = button(name); control.focus()
  expect((await tradeKey('Enter', control)).defaultPrevented).toBe(false)
  expect((await tradeKey('Enter')).defaultPrevented).toBe(false)
  expect(host.querySelector('[data-order-id]')).toBeNull()
  expect((await tradeKey('b', control)).defaultPrevented).toBe(false)
  expect((await tradeKey('b')).defaultPrevented).toBe(false)
  control.blur()
 }
 const elements = ['<input>', '<select><option>Test</option></select>', '<textarea></textarea>', '<a href="#">Link</a>', '<details><summary>Summary</summary></details>', '<div contenteditable="true">Edit</div>', '<div role="button" tabindex="0">Button</div>']
 for (const html of elements) {
  const wrapper = document.createElement('div'); wrapper.innerHTML = html; host.append(wrapper)
  const control = wrapper.querySelector('summary') ?? wrapper.firstElementChild!
  expect((await tradeKey('Enter', control)).defaultPrevented).toBe(false)
  expect((await tradeKey('b', control)).defaultPrevented).toBe(false)
  wrapper.remove()
 }
 // jsdom does not synthesize native Enter clicks; exercise the native action explicitly.
 await tradeKey('Enter', button('Cancel placement')); await click('Cancel placement')
 expect(host.querySelector('.stop-placement')).toBeNull(); expect(host.querySelector('[data-order-id]')).toBeNull()
 await click('Buy'); await pick(1.097)
 await tradeKey('Enter', button('Confirm order')); await click('Confirm order')
 expect(host.querySelectorAll('[data-order-id]')).toHaveLength(1)
})
it('blocks directional confirmation for dialogs, settings overlays, management and session workspace guards', async () => {
 await start(); await click('Buy'); await pick(1.097)
 for (const selector of ['.indicator-controls', '.execution-details']) {
  const panel = host.querySelector<HTMLDetailsElement>(selector)!
  await act(async () => { panel.open = true })
  expect((await tradeKey('b')).defaultPrevented).toBe(false)
  await act(async () => { panel.open = false })
 }
 for (const html of ['<dialog open></dialog>', '<div role="dialog"></div>', '<div aria-modal="true"></div>', '<div class="stop-selector"></div>']) {
  const overlay = document.createElement('div'); overlay.innerHTML = html; host.append(overlay)
  expect((await tradeKey('b')).defaultPrevented).toBe(false)
  overlay.remove()
 }
 const original = persistence.useSessionPersistence
 let guards: Partial<ReturnType<typeof original>> = {}
 vi.spyOn(persistence, 'useSessionPersistence').mockImplementation(options => ({ ...original(options), ...guards }))
 for (const guard of [{ initialized: false }, { busy: true }, { conflict: true }, { awaitingChoice: true }]) {
  guards = guard; await act(async () => root.render(<StrictMode><App/></StrictMode>))
  expect((await tradeKey('b')).defaultPrevented).toBe(false)
  expect(host.querySelector('[data-order-id]')).toBeNull()
 }
 guards = {}; await act(async () => root.render(<StrictMode><App/></StrictMode>))
 await click('Sessions / settings')
 expect((await tradeKey('b')).defaultPrevented).toBe(false)
 await click('Close management'); expect(host.querySelector('[data-order-id]')).toBeNull()
})
it('respects replay and trading permissions even with a selected draft retained', async () => {
 await start(); await click('Buy'); await pick(1.097)
 const original = tradingHook.useTrading
 let permission: Partial<ReturnType<typeof original>['permission']> = {}
 vi.spyOn(tradingHook, 'useTrading').mockImplementation((...args) => {
  const trading = original(...args)
  return { ...trading, permission: { ...trading.permission, ...permission } }
 })
 for (const blocked of [{ active: false }, { playing: true }, { hasFuture: false }]) {
  permission = blocked; await act(async () => root.render(<StrictMode><App/></StrictMode>))
  expect((await tradeKey('b')).defaultPrevented).toBe(false)
  expect(host.querySelector('[data-order-id]')).toBeNull()
 }
 permission = {}; const originalReplay = replayHook.useReplay
 vi.spyOn(replayHook, 'useReplay').mockImplementation((...args) => ({ ...originalReplay(...args), reviewing: true }))
 await act(async () => root.render(<StrictMode><App/></StrictMode>))
 expect((await tradeKey('b')).defaultPrevented).toBe(false)
 expect(host.querySelector('[data-order-id]')).toBeNull()
})
it.each([['Buy', 1.097, 1.098, 'b'], ['Sell', 1.103, 1.104, 's']] as const)('directional confirmation modifies an existing %s position through confirmDraft', async (direction, stop, newStop, key) => {
 await start(); await order(direction, stop); await click('Next Min')
 const original = dock.TradingDock
 // Expose an existing-position draft without adding a new production entry point.
 vi.spyOn(dock, 'TradingDock').mockImplementation(props => <>{original(props)}<button onClick={() => {
  const position = props.trading.state.positions[0]
  props.setDraft({ direction: position.direction, sizing: position.lots, setupId: position.setupId, positionId: position.id, slot: 1, price: newStop })
 }}>Test modify draft</button></>)
 await act(async () => root.render(<StrictMode><App/></StrictMode>))
 await click('Test modify draft')
 expect(button('Confirm SL change').disabled).toBe(false)
 expect((await tradeKey(key === 'b' ? 's' : 'b')).defaultPrevented).toBe(false)
 expect(host.querySelector('.stop-placement')).not.toBeNull()
 expect((await tradeKey(key)).defaultPrevented).toBe(true)
 expect(host.querySelector('.stop-placement')).toBeNull()
 expect(host.querySelector('[data-order-id]')).toBeNull()
 await until(() => host.querySelector('.save-state')?.textContent === 'Saved')
 const state = (await disk.storage.list()).sessions[0].checkpoint.trading
 expect(state.positions).toHaveLength(1)
 expect(state.positions[0].stopPrice).toBe(newStop)
})


it.each([1, 2, 3, 4] as const)('starts and restores a %i-chart layout with every indicator disabled at the first cached date', async count => {
 const workspace=preferences.defaultWorkspace()
 for(const mode of Object.values(workspace.chartModes!)) for(const pane of mode!.indicators) for(const settings of Object.values(pane)) for(const group of Object.values(settings!)) group.enabled=false
 workspace.chartModes!['1']!.timeframes[0]='M1'
 workspace.chartModes!['1']!.indicators[0]={M1:workspace.chartModes!['1']!.indicators[0].D1!}
 Object.assign(workspace,{chartCount:count,...workspace.chartModes![String(count) as '1'|'2'|'3'|'4']})
 vi.spyOn(preferences,'defaultWorkspace').mockImplementation(()=>structuredClone(workspace))
 await mount()
 const first=new Date(preroll[0].timestamp).toISOString().slice(0,10)
 await input('From',first);await input('Through',first)
 expect(button('Start backtest').disabled).toBe(false)
 expect(host.textContent).toContain('No indicator warm-up required')
 await load();await until(()=>host.querySelector('.save-state')?.textContent==='Saved')
 const record=(await disk.storage.list()).sessions[0]
 expect(record.checkpoint.replay.startIndex).toBe(0)
 expect(record.checkpoint.replay.startTimestamp).toBe(preroll[0].timestamp)
 expect(record.checkpoint.workspace.chartCount).toBe(count)
 expect(host.querySelectorAll('.chart-pane')).toHaveLength(count)
 await act(async()=>root.unmount());root=createRoot(host);await mount();await click('Resume backtest');await until(()=>host.querySelector('.phase-trading'))
 expect(host.querySelectorAll('.chart-pane')).toHaveLength(count)
 expect(host.querySelector('.replay-clock')?.textContent).toContain(first)
 expect((await disk.storage.list()).sessions[0].checkpoint.trading.commission).toEqual(record.checkpoint.trading.commission)
})

it('recalculates historical readiness when switching between zero-indicator and D1 Ichimoku modes', async () => {
 const workspace=preferences.defaultWorkspace(),mode=workspace.chartModes!['1']!
 for(const pane of mode.indicators) for(const settings of Object.values(pane)) for(const group of Object.values(settings!)) group.enabled=false
 Object.assign(workspace,{chartCount:1,...mode})
 vi.spyOn(preferences,'defaultWorkspace').mockImplementation(()=>structuredClone(workspace))
 await mount()
 const first=new Date(preroll[0].timestamp).toISOString().slice(0,10)
 await input('From',first);await input('Through',first)
 expect(button('Start backtest').disabled).toBe(false)
 await act(async()=>host.querySelector<HTMLInputElement>('input[name="chart-count"][value="2"]')!.click())
 expect(button('Start backtest').disabled).toBe(true)
 expect(host.textContent).toContain('Insufficient completed historical candles')
 await input('From','2024-01-09');await input('Through','2024-01-09')
 expect(button('Start backtest').disabled).toBe(false)
 expect(host.textContent).toContain('78 required')
 await input('From',first);await input('Through',first)
 await act(async()=>host.querySelector<HTMLInputElement>('input[name="chart-count"][value="1"]')!.click())
 expect(button('Start backtest').disabled).toBe(false)
 expect(host.textContent).toContain('No indicator warm-up required')
 expect(historyCalls).toBe(0)
})


it.each(['H4','D1'])('uses M1 shortcuts on focused %s, synchronizes charts and keeps executed trades during review', async timeframe => {
 const original=tradingHook.useTrading
 let trading!:ReturnType<typeof original>
 vi.spyOn(tradingHook,'useTrading').mockImplementation((...args)=>{trading=original(...args);return trading})
 await mount();await load();await select('Chart 1 timeframe',timeframe)
 const panes=[...host.querySelectorAll('.chart-pane')]
 const timeframes=()=>[...host.querySelectorAll<HTMLSelectElement>('[aria-label$="timeframe"]')].map(el=>el.value)
 const selected=timeframes(),active=panes.map(pane=>pane.getAttribute('data-active'))
 const closes=()=>panes.map(pane=>chartForCanvas(pane.querySelector('.chart-canvas')!).addSeries.mock.results[0].value.data().at(-1)?.close)
 await order('Buy',1.098)
 expect((await shortcut('ArrowRight',window,true)).defaultPrevented).toBe(true)
 expect(host.querySelector('.replay-clock')?.textContent).toContain('00:01')
 expect(trading.state.positions).toHaveLength(1)
 expect(closes()).toEqual([bid[1].close,bid[1].close])
 const state=trading.state,ledger=trading.equity,cursor=trading.executionCursor
 await shortcut('ArrowLeft',window,true)
 expect(host.querySelector('.history-review')?.textContent).toContain('00:00')
 expect(closes()).toEqual([bid[0].close,bid[0].close])
 expect(trading.state).toBe(state);expect(trading.equity).toBe(ledger);expect(trading.executionCursor).toBe(cursor)
 expect(button('Next Min').disabled).toBe(true);expect(button('Buy').disabled).toBe(true)
 await shortcut('ArrowRight',window,true)
 expect(host.querySelector('.history-review')).toBeNull();expect(trading.state).toBe(state)
 expect(closes()).toEqual([bid[1].close,bid[1].close])
 expect(button('Next Min').textContent).toBe('Next Min')
 expect([...host.querySelectorAll('button')].some(button=>button.textContent==='Next Candle')).toBe(false)
 await click('Next Min')
 expect(host.querySelector('.replay-clock')?.textContent).toContain('00:02')
 expect(closes()).toEqual([bid[2].close,bid[2].close])
 await shortcut('ArrowRight')
 expect(host.querySelector('.replay-clock')?.textContent).toContain('00:11')
 expect((await shortcut('ArrowRight',window,true)).defaultPrevented).toBe(false)
 expect(button('Next Min').disabled).toBe(true)
 expect(timeframes()).toEqual(selected)
 expect(panes.map(pane=>pane.getAttribute('data-active'))).toEqual(active)
})

it.each([false, true])('sustains native replay key events without act batching with Ctrl=%s', async ctrlKey => {
 const original = tradingHook.useTrading
 let trading!: ReturnType<typeof original>
 vi.spyOn(tradingHook, 'useTrading').mockImplementation((...args) => { trading = original(...args); return trading })
 const length = bid.length
 bid.push(...Array.from({ length: 700 }, (_, i) => ({ ...bid[0], timestamp: beginning + (length + i) * 60000 })))
 let releaseSave!: () => void
 const saving = new Promise<void>(resolve => { releaseSave = resolve })
 try {
  await mount(); await load(); await select('Chart 1 timeframe', 'M5')
  await until(() => host.querySelector('.save-state')?.textContent === 'Saved')
  const fetch = globalThis.fetch
  vi.stubGlobal('fetch', async (path: string, options?: RequestInit) => {
   if (path.endsWith('/checkpoint') && options?.method === 'PUT') await saving
   return fetch(path, options)
  })
  const panes = [...host.querySelectorAll('.chart-pane')]
  await act(async () => panes[ctrlKey ? 1 : 0].dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
  // act() drains React's queues differently from separate browser key events.
  // Let the real scheduler commit each event; React errors still fail the test.
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false })
  const event = (key: string, repeat = false) => new KeyboardEvent('keydown', { key, shiftKey: true, ctrlKey, repeat, cancelable: true })
  const committed = async (check: () => boolean) => {
   for (let attempt = 0; attempt < 200; attempt++) { if (check()) return; await delay(1) }
   expect(check()).toBe(true)
  }
  for (let step = 0; step < 120; step++) {
   const index = ctrlKey ? step + 1 : (step + 1) * 5 - 1
   const key = event('ArrowRight', step >= 60)
   window.dispatchEvent(key)
   expect(key.defaultPrevented).toBe(true)
   await committed(() => trading.state.observedTimestamp === bid[index].timestamp)
   expect(trading.executionCursor).toBe(preroll.length + index + 1)
   for (const pane of panes) expect(chartForCanvas(pane.querySelector('.chart-canvas')!).addSeries.mock.results[0].value.data().at(-1)?.close).toBe(bid[index].close)
  }
  const state = trading.state, equity = trading.equity, cursor = trading.executionCursor
  for (let step = 0; step < 60; step++) {
   window.dispatchEvent(event('ArrowLeft', step > 0))
   await committed(() => !!host.querySelector('.history-review'))
   expect(button('Buy').disabled).toBe(true)
   window.dispatchEvent(event('ArrowRight', step > 0))
   await committed(() => !host.querySelector('.history-review'))
  }
  expect(trading.state).toBe(state); expect(trading.equity).toBe(equity); expect(trading.executionCursor).toBe(cursor)
  releaseSave()
  await committed(() => host.querySelector('.save-state')?.textContent === 'Saved')
  const saved = (await disk.storage.list()).sessions[0]
  expect(saved.checkpoint.executionCursor).toBe(cursor); expect(saved.checkpoint.trading).toEqual(state)
 } finally {
  releaseSave()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  bid.splice(length)
 }
}, 30_000)

it('applies overlay toggles to every pane and restores them with the session while keeping trading unchanged', async () => {
 const updates = vi.spyOn(TradeOverlays.prototype, 'update')
 const checkToggles = (count: number, executions: boolean, originalSl: boolean) => {
  const calls = updates.mock.calls.slice(-count)
  expect(calls).toHaveLength(count)
  for (const call of calls) expect(call.slice(4)).toEqual([executions, originalSl])
 }
 await start()
 expect(button('Executions').getAttribute('aria-pressed')).toBe('false')
 expect(button('Original SL').getAttribute('aria-pressed')).toBe('false')
 checkToggles(1, false, false)
 await until(()=>host.querySelector('.save-state')?.textContent==='Saved')
 const before=(await disk.storage.list()).sessions[0]
 await click('Executions');await click('Original SL')
 await act(async()=>host.querySelector<HTMLInputElement>('input[name="chart-count"][value="4"]')!.click())
 expect([...host.querySelectorAll<HTMLSelectElement>('.pane-toolbar select')].map(s=>s.value)).toEqual(['H1','D1','M5','H4'])
 checkToggles(4, true, true)
 await until(()=>host.querySelector('.save-state')?.textContent==='Saved')
 expect((await disk.storage.list()).sessions[0].checkpoint.trading).toEqual(before.checkpoint.trading)
 expect(JSON.parse(window.localStorage.getItem(uiKey(before.id))!).slHistory).toBe(true)
 await act(async()=>root.unmount());root=createRoot(host);await mount();await click('Resume backtest');await until(()=>host.querySelector('.phase-trading'))
 expect(host.querySelectorAll('.chart-pane')).toHaveLength(4)
 expect(button('Executions').getAttribute('aria-pressed')).toBe('true')
 expect(button('Original SL').getAttribute('aria-pressed')).toBe('true')
 checkToggles(4, true, true)
 await click('Executions');await click('Original SL')
 expect(button('Executions').getAttribute('aria-pressed')).toBe('false')
 expect(button('Original SL').getAttribute('aria-pressed')).toBe('false')
 checkToggles(4, false, false)
 expect(JSON.parse(window.localStorage.getItem(uiKey(before.id))!).slHistory).toBe(false)
})

function ichimokuEnabled(chart = 1) {
 return host.querySelector<HTMLInputElement>(`[aria-label="Chart ${chart} Ichimoku"]`)!.checked
}
function storedWorkspace(id: string): WorkspaceSettings {
 return JSON.parse(window.localStorage.getItem(uiKey(id))!).workspace
}
async function ichimokuKey(target: EventTarget = window, init: KeyboardEventInit = {}) {
 return tradeKey('i', target, init)
}
it.each([1, 2, 3, 4])('toggles Ichimoku independently on each focused chart in a %i-chart layout', async count => {
 await mount()
 await act(async () => host.querySelector<HTMLInputElement>(`input[name="chart-count"][value="${count}"]`)!.click())
 await load()
 // Matching timeframes must still have independent indicator settings.
 for (let i = 1; i <= count; i++) await select(`Chart ${i} timeframe`, 'H1')
 await until(() => host.querySelector('.save-state')?.textContent === 'Saved')
 let id = ''
 await act(async () => { id = (await disk.storage.list()).sessions[0].id })
 const before = storedWorkspace(id)
 const panes = [...host.querySelectorAll('.chart-pane')]
 for (let i = 0; i < count; i++) {
  await outside(panes[i])
  expect(panes[i].getAttribute('data-active')).toBe('true')
  expect((await ichimokuKey()).defaultPrevented).toBe(true)
  const expected = structuredClone(before)
  expected.indicators[i].H1!.ichimoku.enabled = false
  expected.chartModes![String(count) as '1' | '2' | '3' | '4']!.indicators[i].H1!.ichimoku.enabled = false
  expect(storedWorkspace(id)).toMatchObject({ indicators: expected.indicators, chartModes: expected.chartModes, timeframes: expected.timeframes })
  for (let j = 0; j < count; j++) expect(ichimokuEnabled(j + 1)).toBe(j !== i)
  expect((await ichimokuKey(window, { key: 'I' })).defaultPrevented).toBe(true)
  expect(storedWorkspace(id)).toMatchObject({ indicators: before.indicators, chartModes: before.chartModes, timeframes: before.timeframes })
 }
}, 15_000)
it('uses persistent chart selection after clicking, scrolling, dragging, changing timeframe and removing the focused chart', async () => {
 await start()
 await act(async () => host.querySelector<HTMLInputElement>('input[name="chart-count"][value="4"]')!.click())
 const panes = [...host.querySelectorAll('.chart-pane')]
 const toggleSelected = async (index: number) => {
  const before = panes.map((_, i) => ichimokuEnabled(i + 1))
  expect(panes[index].getAttribute('data-active')).toBe('true')
  expect((await ichimokuKey()).defaultPrevented).toBe(true)
  expect(panes.map((_, i) => ichimokuEnabled(i + 1))).toEqual(before.map((value, i) => i === index ? !value : value))
 }
 await outside(panes[3])
 vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000)
 await toggleSelected(3)
 const canvas = panes[1].querySelector('.chart-canvas')!
 vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 900, height: 650 } as DOMRect)
 await act(async () => { canvasWheel(canvas, 850, 80) })
 await toggleSelected(1)
 await act(async () => panes[2].dispatchEvent(new MouseEvent('pointermove', { bubbles: true, buttons: 1 })))
 await toggleSelected(2)
 await select('Chart 1 timeframe', 'M15')
 await toggleSelected(0)
 await outside(panes[3])
 await act(async () => host.querySelector<HTMLInputElement>('input[name="chart-count"][value="2"]')!.click())
 const before = [ichimokuEnabled(1), ichimokuEnabled(2)]
 expect(host.querySelector('.chart-pane')!.getAttribute('data-active')).toBe('true')
 await ichimokuKey()
 expect([ichimokuEnabled(1), ichimokuEnabled(2)]).toEqual([!before[0], before[1]])
})
it('preserves custom Ichimoku settings, other indicators, timeframe preferences and visibility after a session remount', async () => {
 await start()
 for (const [label, value] of [['Tenkan', '7'], ['Kijun', '17'], ['Span B', '31'], ['Displacement', '11']]) await input(`Chart 1 ${label}`, value)
 await until(() => host.querySelector('.save-state')?.textContent === 'Saved')
 let id = ''
 await act(async () => { id = (await disk.storage.list()).sessions[0].id })
 const original = storedWorkspace(id).indicators[0].D1!
 await ichimokuKey()
 expect(storedWorkspace(id).indicators[0].D1).toEqual({ ...original, ichimoku: { ...original.ichimoku, enabled: false } })
 // The checkbox and shortcut operate on the same persisted visibility flag.
 await act(async () => host.querySelector<HTMLInputElement>('[aria-label="Chart 1 Ichimoku"]')!.click())
 expect(ichimokuEnabled()).toBe(true)
 await ichimokuKey(); expect(ichimokuEnabled()).toBe(false)
 await select('Chart 1 timeframe', 'M5')
 expect(ichimokuEnabled()).toBe(false)
 await ichimokuKey(); expect(ichimokuEnabled()).toBe(true)
 await select('Chart 1 timeframe', 'D1'); expect(ichimokuEnabled()).toBe(false)
 await select('Chart 1 timeframe', 'M5')
 await act(async () => host.querySelector<HTMLInputElement>('input[name="chart-count"][value="3"]')!.click())
 await act(async () => host.querySelector<HTMLInputElement>('input[name="chart-count"][value="1"]')!.click())
 expect(ichimokuEnabled()).toBe(true)
 const saved = storedWorkspace(id)
 await until(() => host.querySelector('.save-state')?.textContent === 'Saved')
 await act(async () => root.unmount()); root = createRoot(host)
 await mount(); await click('Resume backtest'); await until(() => host.querySelector('.phase-trading'))
 expect(ichimokuEnabled()).toBe(true)
 expect(storedWorkspace(id).indicators).toEqual(saved.indicators)
 await select('Chart 1 timeframe', 'D1')
 expect(ichimokuEnabled()).toBe(false)
 expect(storedWorkspace(id).indicators[0].D1).toEqual({ ...original, ichimoku: { ...original.ichimoku, enabled: false } })
 await ichimokuKey()
 expect(storedWorkspace(id).indicators[0].D1).toEqual(original)
}, 15_000)
it('leaves Ichimoku unchanged in text-entry controls, settings, dialogs, drafts and disabled workspaces', async () => {
 await mount()
 expect((await ichimokuKey()).defaultPrevented).toBe(false)
 await act(async () => host.querySelector<HTMLInputElement>('input[name="chart-count"][value="1"]')!.click())
 await load()
 const before = ichimokuEnabled()
 const blocked = async (target: EventTarget = window) => {
  expect((await ichimokuKey(target)).defaultPrevented).toBe(false)
  expect(ichimokuEnabled()).toBe(before)
 }
 for (const html of ['<input>', '<input type="number">', '<select><option>Item</option></select>', '<textarea></textarea>',
  '<div contenteditable="true"><span>Text</span></div>', '<div contenteditable="plaintext-only"><span>Text</span></div>',
  '<div role="textbox"><span>Text</span></div>', '<div role="searchbox"><span>Text</span></div>',
  '<div role="combobox"><span>Text</span></div>', '<div role="spinbutton"><span>Text</span></div>']) {
  const wrapper = document.createElement('div'); wrapper.innerHTML = html; host.append(wrapper)
  const control = wrapper.firstElementChild as HTMLElement
  control.tabIndex = 0
  await blocked(control.firstElementChild ?? control)
  control.focus()
  await blocked(window)
  control.blur(); wrapper.remove()
 }
 for (const selector of ['.indicator-controls', '.execution-details']) {
  const panel = host.querySelector<HTMLDetailsElement>(selector)!
  await act(async () => { panel.open = true })
  await blocked()
  await act(async () => { panel.open = false })
 }
 for (const html of ['<dialog open></dialog>', '<div role="dialog"></div>', '<div class="stop-selector"></div>']) {
  const overlay = document.createElement('div'); overlay.innerHTML = html; host.append(overlay)
  await blocked(); overlay.remove()
 }
 await click('Sessions / settings'); await blocked(); await click('Close management')
 await click('Buy'); await blocked(); await click('Cancel placement')
 const original = persistence.useSessionPersistence
 let guards: Partial<ReturnType<typeof original>> = {}
 vi.spyOn(persistence, 'useSessionPersistence').mockImplementation(options => ({ ...original(options), ...guards }))
 for (const guard of [{ initialized: false }, { busy: true }, { conflict: true }, { awaitingChoice: true }]) {
  guards = guard; await act(async () => root.render(<StrictMode><App/></StrictMode>))
  await blocked()
 }
 guards = {}; await act(async () => root.render(<StrictMode><App/></StrictMode>))
 expect((await ichimokuKey()).defaultPrevented).toBe(true)
 expect(ichimokuEnabled()).toBe(!before)
})
it('toggles Ichimoku once per key press, ignores modified and consumed events and preserves other shortcuts', async () => {
 await start()
 const initial = ichimokuEnabled()
 for (const init of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }]) {
  expect((await ichimokuKey(window, init)).defaultPrevented).toBe(false)
  expect(ichimokuEnabled()).toBe(initial)
 }
 const prevented = new KeyboardEvent('keydown', { key: 'i', cancelable: true })
 prevented.preventDefault(); await act(async () => window.dispatchEvent(prevented))
 expect(ichimokuEnabled()).toBe(initial)
 expect((await ichimokuKey()).defaultPrevented).toBe(true)
 for (let i = 0; i < 5; i++) expect((await ichimokuKey(window, { repeat: true })).defaultPrevented).toBe(false)
 expect(ichimokuEnabled()).toBe(!initial)
 expect((await ichimokuKey()).defaultPrevented).toBe(true)
 expect(ichimokuEnabled()).toBe(initial)
 for (const key of ['x', 'Enter', 'ArrowRight', ' ']) expect((await tradeKey(key)).defaultPrevented).toBe(false)
 expect((await shortcut('ArrowRight', window, true)).defaultPrevented).toBe(true)
 expect(host.querySelector('time')?.textContent).toContain('00:01')
 expect((await tradeKey('b')).defaultPrevented).toBe(true)
 expect(host.querySelector('.stop-placement')?.textContent).toContain('Buy')
 await tradeKey('Escape'); expect(host.querySelector('.stop-placement')).toBeNull()
 expect((await tradeKey('s')).defaultPrevented).toBe(true)
 expect(host.querySelector('.stop-placement')?.textContent).toContain('Sell')
 await tradeKey('Escape')
 expect(ichimokuEnabled()).toBe(initial)
})
