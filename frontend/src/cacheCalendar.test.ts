import { expect, it } from 'vitest'
import { aggregateBidCandles, type Candle, type TradeCandle } from './history'
import { automaticReplayStart, cachedPreset, formatUtcDate, rangeCoverage, type CacheCalendar } from './cacheCalendar'
import { ichimokuWarmup } from './historyLoader'
import { shiftDate } from './workflow'
const bar = (timestamp: number, instrumentId = 101): TradeCandle => ({ timestamp, instrumentId, volume: '1', open: 1, high: 1.2, low: .9, close: 1.1 })
function calendar(): CacheCalendar {
  return { days: Array.from({length:120},(_,index)=>{
    const date=shiftDate('2023-12-02',index)
    return {date,status:'cached',observations:6,h4:Array.from({length:6},(_,hour)=>bar(Date.parse(date)+hour*14400000))}
  }) }
}
it.each([[90,'2024-01-01'],[30,'2024-03-01'],[7,'2024-03-24']])('anchors the %i-day preset to validated history with pre-roll', (days,from)=>{
  expect(cachedPreset(calendar(),days)).toEqual({from,to:'2024-03-31'})
})
it('allows a moved end only when the entire selected period and pre-roll are usable',()=>{
  expect(cachedPreset(calendar(),7,'2024-02-29')).toEqual({from:'2024-02-22',to:'2024-02-29'})
  expect(cachedPreset(calendar(),90,'2024-01-01')).toEqual({from:'2024-01-01',to:'2024-03-31'})
})
it('does not fill holes between cache bounds or skip missing pre-roll dates',()=>{
  const value=calendar();value.days=value.days.filter(day=>day.date!=='2023-12-15')
  expect(cachedPreset(value,90)).toBeNull()
  expect(rangeCoverage(value,{from:'2024-01-01',to:'2024-03-31'}).missing).toBe(1)
  expect(cachedPreset(value,30)).toEqual({from:'2024-03-01',to:'2024-03-31'})
})
it('distinguishes corrupt dates from validated empty exchange-closure days',()=>{
  const value=calendar();value.days[0].h4=[];value.days[0].observations=0
  expect(rangeCoverage(value,{from:'2024-01-01',to:'2024-03-31'}).missing).toBe(0)
  value.days[0].status='invalid'
  expect(cachedPreset(value,90)).toBeNull()
})
it('has an explicit empty result when no eligible cached range exists',()=>{
  expect(cachedPreset({days:[]},7)).toBeNull()
  const value=calendar();value.days.forEach(day=>{day.h4=[];day.observations=0})
  expect(cachedPreset(value,90)).toBeNull()
})
it('formats leap dates and uses UTC rather than local midnight',()=>{
  expect(formatUtcDate('2024-02-29')).toBe('29 Feb 2024')
  expect(formatUtcDate(Date.parse('2024-02-29T23:59:00Z'))).toBe('29 Feb 2024')
  expect(shiftDate('2024-03-01',-1)).toBe('2024-02-29')
})
it('finds the first actual minute after 78 completed observed buckets, excluding the current bucket',()=>{
  const from=Date.parse('2024-01-01'),bars=Array.from({length:80},(_,i)=>bar(from+i*14400000+60000))
  const result=automaticReplayStart(bars,{from:'2024-01-01',to:'2024-01-15'})!
  expect(result).toMatchObject({index:78,count:78,timestamp:from+78*14400000+60000})
  expect(ichimokuWarmup(bars,result.timestamp)).toEqual({count:78,required:78,ready:true})
  expect(ichimokuWarmup(bars,result.timestamp-120000).count).toBe(77)
})
it('does not invent observations for weekends, missing buckets or closures',()=>{
  const from=Date.parse('2024-01-01'),bars=Array.from({length:79},(_,i)=>bar(from+i*86400000))
  expect(automaticReplayStart(bars,{from:'2024-01-01',to:'2024-03-01'})).toBeNull()
})
it('resets warm-up at each contract change, including a return to an earlier contract',()=>{
  const start=Date.parse('2024-01-01'), bars=Array.from({length:100},(_,i)=>bar(start+i*14400000,i<77?101:i<79?202:101))
  expect(automaticReplayStart(bars,{from:'2024-01-01',to:'2024-01-20'})).toBeNull()
  expect(ichimokuWarmup(bars,bars[99].timestamp).count).toBe(20)
})
it('does not let an intra-bucket contract change count as a complete warm-up bucket',()=>{
  const start=Date.parse('2024-01-01'),bars=Array.from({length:78},(_,i)=>bar(start+i*14400000))
  bars.push(bar(bars.at(-1)!.timestamp+60000,202))
  expect(automaticReplayStart(bars,{from:'2024-01-01',to:'2024-01-15'})).toBeNull()
})
it('does not change eligibility when future observations or prices change',()=>{
  const value=calendar(),range={from:'2024-01-01',to:'2024-03-31'},bars=value.days.flatMap(day=>day.h4)
  const expected=automaticReplayStart(bars,range)!
  const changed=bars.map(bar=>bar.timestamp>expected.timestamp?{...bar,high:10000,close:10000}:bar)
  expect(automaticReplayStart(changed,range)).toEqual(expected)
  expect(automaticReplayStart(bars.slice(0,expected.index+1),range)).toEqual(expected)
})
it('keeps the first eligible minute inside the exclusive interval end',()=>{
  const bars=Array.from({length:90},(_,i)=>bar(Date.parse('2024-01-01')+i*14400000))
  expect(automaticReplayStart(bars,{from:'2024-01-01',to:'2024-01-14'})).toBeNull()
})
it('summary eligibility matches full M1 eligibility including late bucket openings',()=>{
  const bars=Array.from({length:90},(_,i)=>bar(Date.parse('2024-01-01')+i*14400000+120000))
  const minuteBars=bars.flatMap(bar=>[bar,{...bar,timestamp:bar.timestamp+60000}])
  const range={from:'2024-01-14',to:'2024-01-16'}
  expect(automaticReplayStart(minuteBars,range)?.timestamp).toBe(automaticReplayStart(bars,range)?.timestamp)
  expect(aggregateBidCandles(minuteBars,'H4')).toHaveLength(90)
})
it('handles empty, invalid and oversized manual date ranges without scanning an archive',()=>{
 for(const range of [{from:'',to:'2024-01-01'},{from:'2020-01-01',to:'2024-01-01'},{from:'2024-01-02',to:'2024-01-01'}])expect(rangeCoverage(calendar(),range).replay).toBeNull()
 expect(formatUtcDate('')).toBe('Choose date')
})
