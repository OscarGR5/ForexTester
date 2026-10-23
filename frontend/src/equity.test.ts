import { describe, expect, it } from 'vitest'
import { createEquityLedger, recordEquity } from './equity'
import { downsampleEquity, equityObservations } from './EquityChart'
import { createTradingState, grossPnl, modifyStop, observeCandle, requestClose, requestEntry } from './trading'
import { realizedPerformance } from './analytics'

const permission={active:true,playing:false,hasFuture:true}
const start=Date.UTC(2024,0,9)
const candle=(minute:number,price=1.1)=>({timestamp:start+minute*60_000,open:price,high:price+0.00001,low:price-0.00001,close:price})
function session() {
 let state=createTradingState(1,{referenceBalance:10000,maxRiskPercent:100},{roundTripUsdPerLot:7})
 let ledger=createEquityLedger(10000)
 return {get state(){return state},get ledger(){return ledger},
   change(fn:(s:typeof state)=>typeof state){state=fn(state)},
   tick(minute:number,bid=1.1,ask:number|undefined=1.1002){const previous=state;state=observeCandle(state,candle(minute,bid),ask===undefined?undefined:candle(minute,ask));ledger=recordEquity(ledger,previous,state)},
   missing(minute:number){const previous=state;state=observeCandle(state,candle(minute));ledger=recordEquity(ledger,previous,state)} }
}

describe('incurred cash and M1 mark-to-market accounting',()=>{
 it('independently matches the $10,000, one-lot, $7 fee example',()=>{
  const s=session();s.tick(0)
  s.change(state=>requestEntry(state,'buy',1,1.09,permission));s.tick(1)
  expect(s.ledger.cashUsd).toBeCloseTo(9996.5,8)
  expect(s.ledger.tail!.point.unrealizedUsd).toBeCloseTo(-20,8)
  expect(s.ledger.tail!.point.equityUsd).toBeCloseTo(9976.5,8)
  expect(s.ledger.maxDrawdownUsd).toBeCloseTo(23.5,8)
  s.change(state=>requestClose(state,state.positions[0].id,permission));s.tick(2)
  expect(s.state.closed[0].netPnlUsd).toBeCloseTo(-27,8)
  expect(s.ledger.cashUsd).toBeCloseTo(9973,8)
  expect(s.ledger.tail!.point.equityUsd).toBeCloseTo(9973,8)
  expect(s.ledger.tail!.point.unrealizedUsd).toBe(0)
 })
 it('marks short to ask and reconciles both identities with two positions at every event',()=>{
  const s=session();s.tick(0)
  s.change(state=>requestEntry(state,'buy',1,1.08,permission))
  s.change(state=>requestEntry(state,'sell',0.5,1.12,permission));s.tick(1)
  expect(s.ledger.tail!.point.unrealizedUsd).toBeCloseTo(-30,8)
  expect(s.ledger.cashUsd).toBeCloseTo(9994.75,8)
  for(let minute=2;minute<8;minute++) {
   if(minute===4)s.change(state=>requestClose(state,state.positions[0].id,permission))
   if(minute===6)s.change(state=>requestClose(state,state.positions[0].id,permission))
   s.tick(minute,1.101,1.1013)
   const expected=10000+s.state.closed.reduce((sum,p)=>sum+p.netPnlUsd,0)+s.state.positions.reduce((sum,p)=>sum+grossPnl(p,p.direction==='buy'?1.101:1.1013).usd-p.entryCommissionUsd,0)
   expect(s.ledger.tail!.point.equityUsd).toBeCloseTo(expected,8)
  }
 })
 it('accounts for same-candle entry and SL once, including both fees',()=>{
  const s=session();s.tick(0)
  s.change(state=>requestEntry(state,'buy',1,1.1001,permission));s.tick(1)
  expect(s.state.positions).toHaveLength(0);expect(s.state.closed).toHaveLength(1)
  expect(s.ledger.cashUsd).toBeCloseTo(9973,8) // bid open 1.1000 gaps below 1.1001
  expect(recordEquity(s.ledger,s.state,s.state)).toBe(s.ledger)
 })
 it('moving SL creates no cash transaction; intratrade loss exceeds realized drawdown',()=>{
  const s=session();s.tick(0);s.change(state=>requestEntry(state,'buy',1,1.08,permission));s.tick(1)
  s.change(state=>modifyStop(state,state.positions[0].id,1.085,permission));s.tick(2,1.09,1.0902)
  expect(s.ledger.cashUsd).toBeCloseTo(9996.5,8)
  expect(s.ledger.maxDrawdownUsd).toBeCloseTo(1023.5,8)
  expect(realizedPerformance(s.state.closed,10000).maxDrawdownUsd).toBe(0)
  s.tick(3,1.11,1.1102)
  expect(s.ledger.highWaterMarkUsd).toBeCloseTo(10976.5,8)
 })
 it('preserves cash and gaps when short marks need missing ask; bid alone marks longs',()=>{
  const long=session();long.tick(0);long.change(state=>requestEntry(state,'buy',1,1.08,permission));long.tick(1);long.missing(2)
  expect(long.ledger.tail!.point.equityUsd).toBeCloseTo(9976.5,8)
  const short=session();short.tick(0);short.change(state=>requestEntry(state,'sell',1,1.12,permission));short.tick(1);short.missing(2)
  expect(short.ledger.tail!.point.equityUsd).toBeNull();expect(short.ledger.tail!.point.drawdownUsd).toBeNull()
  expect(short.ledger.cashUsd).toBeCloseTo(9996.5,8);expect(short.ledger.missingCount).toBe(1)
  short.tick(3);expect(short.ledger.tail!.point.equityUsd).toBeCloseTo(9976.5,8)
  short.tick(10);expect(short.ledger.tail!.point.clockGap).toBe(true)
 })
 it('requires every open position side, while a short can use ask without bid',()=>{
  const s=session();s.tick(0);s.change(state=>requestEntry(state,'sell',0.5,1.12,permission));s.tick(1)
  const previous=s.state
  const next=observeCandle(previous,{...candle(2),low:2},candle(2,1.1002))
  const short=recordEquity(s.ledger,previous,next)
  expect(short.tail!.point.equityUsd).toBeCloseTo(9988.25,8)
  s.change(state=>requestEntry(state,'buy',0.5,1.08,permission));s.tick(2)
  const before=s.state, missing=observeCandle(before,candle(3))
  const portfolio=recordEquity(s.ledger,before,missing)
  expect(portfolio.tail!.point.missingSides).toEqual(['ask'])
  expect(portfolio.tail!.point.equityUsd).toBeNull()
  expect(portfolio.tail!.point.cashUsd).toBeCloseTo(9996.5,8)
 })
 it('reports percentage unavailable at zero or negative equity without NaN',()=>{
  const s=session();s.tick(0);s.change(state=>requestEntry(state,'buy',1,1.01,permission));s.tick(1)
  s.tick(2,0.95,0.9502)
  expect(s.ledger.nonpositiveEquity).toBe(true);expect(s.ledger.maxDrawdownPercent).toBeNull()
  expect(s.ledger.maxDrawdownUsd).toBeGreaterThan(10000)
 })
 it('downsamples display only while preserving extrema, endpoints and unavailable regions',()=>{
  const s=session();s.tick(0);s.change(state=>requestEntry(state,'sell',1,1.19,permission));s.tick(1)
  for(let minute=2;minute<2000;minute++) {
   if(minute===500 || minute===501)s.missing(minute)
   else s.tick(minute,1.1,minute===1000?1.15:1.1002)
  }
  const points=equityObservations(s.ledger), sampled=downsampleEquity(points,100)
  expect(sampled.length).toBeLessThan(300)
  expect(sampled[0]).toBe(points[0]);expect(sampled.at(-1)).toBe(points.at(-1))
  expect(sampled).toContain(points[1000]);expect(sampled).toContain(points[499]);expect(sampled).toContain(points[500]);expect(sampled).toContain(points[501]);expect(sampled).toContain(points[502])
  expect(s.ledger.maxDrawdownUsd).toBeCloseTo(5003.5,8)
 })
})
