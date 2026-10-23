import { describe, expect, it, vi } from 'vitest'
import type { IChartApi } from 'lightweight-charts'
import { ReplayBars } from './replayBars'
import { IndicatorSeries } from './indicatorSeries'
import { calculateIndicators, defaultIndicatorSettings, type ChartCandle } from './indicators'
import { TIMEFRAMES, toBidChartCandles } from './history'

export function fakeChart() {
 const series: {title:string;values: {time:number;value?:number}[];setData:ReturnType<typeof vi.fn>}[]=[]
 const chart={
  addSeries: (_type:unknown,options:{title:string})=>{
   const line={title:options.title,values:[] as {time:number;value?:number}[],setData:vi.fn(),
    update(point:{time:number;value?:number},historical=false){
     const at=line.values.findIndex(p=>p.time===point.time)
     if(at>=0)line.values[at]={...point}
     else {if(historical || (line.values.length && point.time<line.values.at(-1)!.time))throw Error('Out-of-order update');line.values.push({...point})}
    },attachPrimitive:vi.fn(),detachPrimitive:vi.fn(),createPriceLine:vi.fn(),priceScale:()=>({applyOptions:vi.fn()})}
   line.setData.mockImplementation((data:typeof line.values)=>{line.values=data.map(p=>({...p}))})
   series.push(line);return line
  },removeSeries:vi.fn(),panes:()=>[{setStretchFactor:vi.fn()},{setStretchFactor:vi.fn()}],
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
