// Validates authentic cached observations without credentials or network requests.
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { HistoryService } from '../backend/src/history.js'
import { calculateIndicators, defaultIndicatorSettings } from '../frontend/src/indicators.js'
import { aggregateBidCandles, type TradeCandle, type Timeframe } from '../frontend/src/history.js'
import { createTradingState, observeCandle, requestEntry, requestClose } from '../frontend/src/trading.js'
const root = (process.env.FOREXTESTER_CACHE_DIR ?? '/home/admin/.cache/forextester-databento-verification-20261024') + '/databento'
const history = await new HistoryService(undefined,root).readCached('2023-12-02','2024-03-31')
const sameContract = history.candles.filter(b=>b.instrumentId===156627)
const indicators: any[] = [], settings=defaultIndicatorSettings()
for(const group of Object.values(settings))group.enabled=true
const near=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`)
for(const timeframe of ['M1','M5','M15','H1','H4'] as Timeframe[]) {
 const bars=aggregateBidCandles(sameContract,timeframe).slice(-400).map(({timestamp,...bar})=>({time:timestamp/1000 as any,...bar}))
 const output=calculateIndicators(bars,settings,timeframe)
 const mean=(values:number[])=>values.reduce((a,b)=>a+b,0)/values.length
 const window=bars.slice(-settings.bollinger.length).map(b=>b.close),middle=mean(window),sd=Math.sqrt(mean(window.map(v=>(v-middle)**2)))
 near(output.middle.at(-1)!.value,middle);near(output.upper.at(-1)!.value,middle+settings.bollinger.stdDev*sd);near(output.lower.at(-1)!.value,middle-settings.bollinger.stdDev*sd)
 const midpoint=(period:number)=>{const part=bars.slice(-period);return (Math.max(...part.map(b=>b.high))+Math.min(...part.map(b=>b.low)))/2}
 near(output.tenkan.at(-1)!.value,midpoint(settings.ichimoku.tenkan));near(output.kijun.at(-1)!.value,midpoint(settings.ichimoku.kijun));near(output.spanB.at(-1)!.value,midpoint(settings.ichimoku.spanB))
 const raw=bars.map((bar,index)=>{if(index+1<settings.stochastic.length)return null;const part=bars.slice(index-settings.stochastic.length+1,index+1),hi=Math.max(...part.map(b=>b.high)),lo=Math.min(...part.map(b=>b.low));return hi===lo?null:100*(bar.close-lo)/(hi-lo)})
 const k=raw.map((v,index)=>{const part=raw.slice(index-settings.stochastic.smoothK+1,index+1);return v===null||index+1<settings.stochastic.smoothK||part.some(v=>v===null)?null:mean(part as number[])})
 const d=k.slice(-settings.stochastic.smoothD)
 near(output.k.at(-1)!.value,k.at(-1)!);near(output.d.at(-1)!.value,mean(d as number[]))
 indicators.push({timeframe,bars:bars.length,bollinger:true,stochastic:true,ichimoku:true})
}
const permission={active:true,playing:false,hasFuture:true}
const observe=(state:ReturnType<typeof createTradingState>,bar:TradeCandle)=>observeCandle(state,bar,undefined,'single')
const execution: Record<string,boolean>={}
for(const direction of ['buy','sell'] as const) {
 for(let index=1;index<sameContract.length;index++) {
  const previous=sameContract[index-1],bar=sameContract[index]
  const bound=direction==='buy'?Math.min(previous.close,bar.open):Math.max(previous.close,bar.open)
  if(direction==='buy'?bar.low>=bound:bar.high<=bound)continue
  const stop=(bound+(direction==='buy'?bar.low:bar.high))/2
  let state=observe(createTradingState(),previous);state=requestEntry(state,direction,.01,stop,permission);state=observe(state,bar)
  assert.equal(state.closed[0].exitReason,'stop_loss');assert.equal(state.closed[0].stopFillType,'level');assert.equal(state.closed[0].exitPrice,stop)
  execution[`${direction}SameBarStop`]=true;break
 }
}
for(let index=2;index<sameContract.length;index++) {
 const before=sameContract[index-2],entry=sameContract[index-1],gap=sameContract[index]
 if(gap.timestamp<=entry.timestamp+60000||gap.open>=entry.low)continue
 const stop=(gap.open+entry.low)/2
 let state=observe(createTradingState(),before);state=requestEntry(state,'buy',.01,stop,permission);state=observe(state,entry)
 if(!state.positions.length)continue
 state=observe(state,gap);assert.equal(state.closed[0].stopFillType,'gap_open');assert.equal(state.closed[0].exitPrice,gap.open)
 execution.actualGapOpenStop=true;break
}
assert.ok(execution.buySameBarStop&&execution.sellSameBarStop)
await writeFile('docs/databento/offline-authentic-checks.json',JSON.stringify({source:'Previously validated authentic Databento cache',paidRequests:0,indicators,execution},null,2)+'\n')
console.log(JSON.stringify({indicators,execution}))
