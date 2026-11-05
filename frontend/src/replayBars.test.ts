import { describe, expect, it, vi } from 'vitest'
import type { IChartApi } from 'lightweight-charts'
import { ReplayBars } from './replayBars'
import { INDICATOR_COLORS, IndicatorSeries, SERIES_BATCH_THRESHOLD } from './indicatorSeries'
import { calculateIndicators, defaultIndicatorSettings, type ChartCandle } from './indicators'
import { TIMEFRAMES, toBidChartCandles } from './history'

export function fakeChart() {
 const series: {title:string;values: {time:number;value?:number}[];setData:ReturnType<typeof vi.fn>}[]=[]
 const chart={
  addSeries: vi.fn((_type:unknown,options:{title:string})=>{
   const line={setSeriesOrder:vi.fn(),applyOptions:vi.fn(),title:options.title,values:[] as {time:number;value?:number}[],setData:vi.fn(),
    update(point:{time:number;value?:number},historical=false){
     const at=line.values.findIndex(p=>p.time===point.time)
     if(at>=0)line.values[at]={...point}
     else {if(historical || (line.values.length && point.time<line.values.at(-1)!.time))throw Error('Out-of-order update');line.values.push({...point})}
    },attachPrimitive:vi.fn(),detachPrimitive:vi.fn(),createPriceLine:vi.fn(),priceScale:()=>({applyOptions:vi.fn()})}
   line.setData.mockImplementation((data:typeof line.values)=>{line.values=data.map(p=>({...p}))})
   series.push(line);return line
  }),removeSeries:vi.fn(),panes:()=>[{setStretchFactor:vi.fn()},{setStretchFactor:vi.fn()}],
 }
 return {chart:chart as unknown as IChartApi,series}
}
const source=Array.from({length:4000},(_,i)=>({timestamp:Date.UTC(2024,0,1)+(i+(i>=3800?2880:0))*60_000,
 open:1.1+Math.sin(i/9)*0.001,high:1.104+Math.sin(i/11)*0.001,low:1.096+Math.cos(i/13)*0.001,close:1.1+Math.cos(i/7)*0.001}))

describe('incremental chart data and bounded indicator tails',()=>{
 for(const tf of TIMEFRAMES)it(`matches full causal ${tf} aggregation at partial and batched advances`,()=>{
  const bars=new ReplayBars(tf)
  for(const count of [1,29,30,88,700,3800,3801,3900,4000]) {
   bars.advance(source,count)
   expect(bars.candles).toEqual(toBidChartCandles({bid:source.slice(0,count)},tf))
  }
 })
 it('matches full indicator results after ordinary ticks, batched advances and a weekend gap',()=>{
  const {chart,series}=fakeChart(), manager=new IndicatorSeries(chart), bars=new ReplayBars('M1')
  const settings=defaultIndicatorSettings();for(const group of Object.values(settings))group.enabled=true
  for(const count of [3000,3001,3101,3800,3801,3900,4000]) {
   bars.advance(source,count);manager.update(bars.candles,settings,'M1',count===3000)
   const expected=calculateIndicators(bars.candles,settings,'M1')
   for(const line of series){
    const actual=line.values.filter(p=>p.value!==undefined)
    const reference=expected[line.title as keyof typeof expected] as {time:number;value:number}[]
    expect(actual.map(p=>p.time)).toEqual(reference.map(p=>p.time))
    for(let i=0;i<actual.length;i++)expect(actual[i].value).toBeCloseTo(reference[i].value,8)
   }
   if(count===3101)for(const line of series)expect(line.setData).toHaveBeenCalledTimes(1)
  }
 })
 it('keeps stochastic undefined through flat windows then restarts smoothing',()=>{
  const {chart,series}=fakeChart(), manager=new IndicatorSeries(chart)
  const settings=defaultIndicatorSettings();settings.stochastic.enabled=true
  const candles:ChartCandle[]=toBidChartCandles({bid:source.slice(0,300)})
  for(let i=200;i<260;i++)candles[i]={...candles[i],open:1.1,high:1.1,low:1.1,close:1.1}
  manager.update(candles.slice(0,240),settings,'M1',true)
  manager.update(candles,settings,'M1',false)
  const expected=calculateIndicators(candles,settings,'M1')
  for(const line of series)expect(line.values).toEqual(expected[line.title as 'k'|'d'])
 })
})

it('batches only changed lines at the threshold, preserving exact historical and whitespace points', () => {
 const { chart, series } = fakeChart(), manager = new IndicatorSeries(chart)
 const settings = defaultIndicatorSettings(); settings.ichimoku.enabled = true
 const candles = toBidChartCandles({ bid: source.slice(0, 200) })
 manager.update(candles, settings, 'M1', true)
 const snapshots = new Map(series.map(line => [line.title, line.values.map(point => ({ ...point }))]))
 const updates = new Map(series.map(line => [line.title, vi.spyOn(line as any, 'update')]))
 // Change closes at historical positions without changing the high/low windows.
 // Only Chikou is affected, and its affected positions precede the live tail.
 const line = series.find(line => line.title === 'chikou')!
 const sync = manager as unknown as { syncLine(entry: { series: unknown; data: typeof line.values }, tail: typeof line.values, replace: boolean, cutoff: number): void }
 const data = line.values.map(point => ({ ...point }))
 const managed = { series: line, data }
 const tail = data.slice(-SERIES_BATCH_THRESHOLD).map(point => ({ ...point, value: point.value! + 0.00001 }))
 sync.syncLine(managed, tail, false, tail[0].time)
 expect(line.setData).toHaveBeenCalledTimes(2)
 expect(updates.get('chikou')).not.toHaveBeenCalled()
 expect(managed.data).toBe(data)
 expect(line.setData).toHaveBeenLastCalledWith(data)
 expect(line.values).toEqual([...snapshots.get('chikou')!.slice(0, -tail.length), ...tail])
 for (const other of series.filter(item => item !== line)) {
  expect(other.setData).toHaveBeenCalledTimes(1)
  expect(other.values).toEqual(snapshots.get(other.title))
 }
 // Whitespace is part of a complete replacement, including when its value changes.
 const span = series.find(line => line.title === 'spanA')!
 const projected = span.values.map(point => ({ ...point })), spanLine = { series: span, data: projected }
 const projectedTail = projected.slice(-SERIES_BATCH_THRESHOLD).map(({ time }) => ({ time }))
 sync.syncLine(spanLine, projectedTail, false, projectedTail[0].time)
 expect(span.values).toEqual(projected)
 expect(span.values.slice(-projectedTail.length)).toEqual(projectedTail)
})

it('counts changed points rather than dirty-tail length and skips unchanged series', () => {
 const { chart, series } = fakeChart(), manager = new IndicatorSeries(chart)
 const settings = defaultIndicatorSettings(); settings.bollinger.enabled = true
 const candles = toBidChartCandles({ bid: source.slice(0, 200) })
 manager.update(candles, settings, 'M1', true)
 const line = series.find(line => line.title === 'middle')!
 const update = vi.spyOn(line as any, 'update')
 const data = line.values.map(point => ({ ...point })), managed = { series: line, data }
 const sync = manager as unknown as { syncLine(line: typeof managed, tail: typeof data, replace: boolean, cutoff: number): void }
 sync.syncLine(managed, data.slice(), false, data[0].time)
 expect(update).not.toHaveBeenCalled(); expect(line.setData).toHaveBeenCalledTimes(1)
 const tail = data.map(point => ({ ...point }))
 for (let index = 0; index < SERIES_BATCH_THRESHOLD - 1; index++) tail[index].value! += 0.00001
 sync.syncLine(managed, tail, false, tail[0].time)
 expect(update).toHaveBeenCalledTimes(SERIES_BATCH_THRESHOLD - 1)
 expect(update.mock.calls.every(call => call[1] === true)).toBe(true)
 expect(line.setData).toHaveBeenCalledTimes(1)
 expect(line.values).toEqual(tail)
})

it('reports no dirty candles when higher-timeframe OHLC is unchanged', () => {
 const bars = new ReplayBars('H4')
 const flat = source.slice(0, 4).map((candle) => ({ ...candle, open: 1.1, high: 1.2, low: 1, close: 1.15 }))
 bars.advance(flat, 1)
 const previous = bars.candles[0]
 expect(bars.advance(flat, 2)).toBe(1)
 expect(bars.candles[0]).toBe(previous)
 expect(bars.advance(flat, 2)).toBe(1)
})

it('appends newly warm indicator observations without replacing historical lines', () => {
 const { chart, series } = fakeChart(), manager = new IndicatorSeries(chart), bars = new ReplayBars('M1')
 const settings = defaultIndicatorSettings(); settings.bollinger.enabled = true; settings.stochastic.enabled = true
 bars.advance(source, 1); manager.update(bars.candles, settings, 'M1', true)
 for (let count = 2; count < 90; count++) { bars.advance(source, count); manager.update(bars.candles, settings, 'M1', false) }
 const expected = calculateIndicators(bars.candles, settings, 'M1')
 for (const line of series) {
  expect(line.setData).toHaveBeenCalledTimes(1)
  expect(line.values.map(p => p.time)).toEqual(expected[line.title as 'k'].map(p => p.time))
  for (let i = 0; i < line.values.length; i++) expect(line.values[i].value).toBeCloseTo(expected[line.title as 'k'][i].value, 8)
 }
})

it('rebuilds exact custom Bollinger settings and visibility when settings change', () => {
 const { chart, series } = fakeChart(), manager = new IndicatorSeries(chart), bars = new ReplayBars('M5')
 const settings = defaultIndicatorSettings(); settings.bollinger.enabled = true
 bars.advance(source, 1500); manager.update(bars.candles, settings, 'M5', true)
 const changed = { ...settings, bollinger: { ...settings.bollinger, length: 37, stdDev: 1.7, basisVisible: false } }
 manager.update(bars.candles, changed, 'M5', true)
 expect(chart.removeSeries).toHaveBeenCalledTimes(1)
 const expected = calculateIndicators(bars.candles, changed, 'M5')
 for (const line of series.filter(line => line.title !== 'middle')) {
  expect(line.values.map(p => p.time)).toEqual(expected[line.title as 'upper'].map(p => p.time))
  for (let i = 0; i < line.values.length; i++) expect(line.values[i].value).toBeCloseTo(expected[line.title as 'upper'][i].value, 8)
 }
})

it.each(['M5','M15','H1','H4','D1'] as const)('orders every price overlay behind candles on %s, including re-enabled lines', timeframe => {
 const {chart,series}=fakeChart(),manager=new IndicatorSeries(chart)
 const settings=defaultIndicatorSettings()
 settings.bollinger.enabled=true;settings.bollinger2.enabled=true;settings.ichimoku.enabled=true;settings.stochastic.enabled=true
 const candles=toBidChartCandles({bid:source},timeframe)
 manager.update(candles,settings,timeframe,true)
 const priceLines=series.filter(line=>!['k','d'].includes(line.title))
 for (const [, options] of vi.mocked(chart.addSeries).mock.calls) {
  const { title, lineWidth, color } = options as { title: keyof typeof INDICATOR_COLORS; lineWidth: number; color: string }
  expect(lineWidth).toBe(['tenkan', 'kijun', 'chikou', 'spanA', 'spanB'].includes(title) ? 2 : 1)
  expect(color).toBe(INDICATOR_COLORS[title])
 }
 expect(priceLines.length).toBeGreaterThan(6)
 for(const line of priceLines) expect((line as any).setSeriesOrder).toHaveBeenCalledWith(0)
 for(const line of series.filter(line=>['k','d'].includes(line.title))) expect((line as any).setSeriesOrder).not.toHaveBeenCalled()
 const disabled={...settings,bollinger:{...settings.bollinger,enabled:false}}
 manager.update(candles,disabled,timeframe,true);manager.update(candles,settings,timeframe,true)
 for(const line of series.slice(-3)) expect((line as any).setSeriesOrder).toHaveBeenCalledWith(0)
 manager.dispose()
})
