import { expect, it } from 'vitest'
import { parseHistory, aggregateBidCandles, rolloverIndex, type LocalForexHistory, type Candle } from './history'
import { historyFingerprint, validatedHistory } from './sessionCodec'
import { createTradingState, observeCandle, requestAutomaticEntry, requestClose, modifyStop, grossPnl } from './trading'
import { recordEquity,createEquityLedger } from './equity'
import { localHistory } from '../../tests/localHistoryFixture'
import { fixtureHistory } from '../../tests/databentoFixture'
const permission={active:true,playing:false,hasFuture:true}
const bar=(timestamp:number,open:number,low=open-.0002,high=open+.0002,close=open):Candle=>({timestamp,open,high,low,close})
it('keeps local identity distinct from both legacy fingerprints and rejects altered semantics',async()=>{
 const local=localHistory(),legacy=fixtureHistory(local.from,local.to)
 expect(await historyFingerprint(local)).not.toBe(await historyFingerprint({...legacy,tradingFrom:local.tradingFrom}))
 expect(await historyFingerprint(local)).toBe(await historyFingerprint(validatedHistory(local)))
 for(const change of [{priceBasis:'bid'},{timestampConvention:'utc-minute-close'},{executionModel:'futures'},{source:'databento'},{contracts:[]}])expect(()=>parseHistory({...local,...change},local)).toThrow()
 expect(()=>parseHistory({...local,candles:[{...local.candles[0],instrumentId:101}]},local)).toThrow()
})
it('fills two independent EURUSD risk orders at the next observed mid open, then handles level and gap stops with commissions',()=>{
 const start=Date.UTC(2024,2,8,21,59),first=bar(start,1.1)
 let state=observeCandle({...createTradingState(1,undefined,{roundTripUsdPerLot:7}),symbol:'EURUSD',executionModel:'single-price-m1-v1'},first,undefined,'single')
 state=requestAutomaticEntry(state,'buy',{mode:'risk',riskPercent:.1},1.099,permission)
 state=requestAutomaticEntry(state,'buy',{mode:'risk',riskPercent:.1},1.098,permission)
 expect(state.positions).toHaveLength(0);expect(state.pending).toHaveLength(2)
 state=observeCandle(state,bar(Date.UTC(2024,2,10,22,15),1.1002),undefined,'single')
 expect(state.symbol).toBe('EURUSD');expect(state.setups.every(s=>s.symbol==='EURUSD')).toBe(true)
 expect(state.positions).toHaveLength(2);expect(state.positions[0].lots).toBe(.83);expect(state.positions[1].lots).toBe(.45)
 state=observeCandle(state,bar(Date.UTC(2024,2,10,22,16),1.1001,1.0989,1.1004),undefined,'single')
 expect(state.closed[0].stopFillType).toBe('level');expect(state.closed[0].netPnlUsd).toBeCloseTo(-105.41,6)
 expect(state.positions).toHaveLength(1)
 state=modifyStop(state,state.positions[0].id,1.0995,permission)
 state=observeCandle(state,bar(Date.UTC(2024,2,10,22,17),1.099),undefined,'single')
 expect(state.closed[1].stopFillType).toBe('gap_open');expect(state.closed[1].exitPrice).toBe(1.099)
 expect(state.closed[1].netPnlUsd).toBeCloseTo(grossPnl(state.closed[1],1.099).usd-7*.45,8)
})
it.each(['buy','sell'] as const)('uses the next observed open for a %s manual close and marks EURUSD equity without a synthetic spread',direction=>{
 const start=Date.UTC(2024,2,15),first=bar(start,1.1)
 let state=observeCandle({...createTradingState(1,undefined,{roundTripUsdPerLot:7}),symbol:'EURUSD',executionModel:'single-price-m1-v1'},first,undefined,'single')
 let ledger=createEquityLedger(100000)
 state=requestAutomaticEntry(state,direction,1,direction==='buy'?1.09:1.11,permission)
 let previous=state;state=observeCandle(state,bar(start+60000,1.1001),undefined,'single');ledger=recordEquity(ledger,previous,state)
 expect(ledger.tail?.point.unrealizedUsd).toBe(0);expect(ledger.cashUsd).toBe(99996.5)
 state=requestClose(state,state.positions[0].id,permission)
 expect(state.closed).toHaveLength(0)
 state=observeCandle(state,bar(start+180000,1.1003),undefined,'single')
 expect(state.closed[0].exitTime).toBe(start+180000)
 expect(state.closed[0].netPnlUsd).toBeCloseTo((direction==='buy'?20:-20)-7,7)
 expect(state.closed[0].coverageWarnings[0].reason).toBe('clock_gap')
})
it('aggregates only the supplied revealed prefix and crosses former futures rollover dates without a boundary',()=>{
 const candles=[bar(Date.UTC(2024,2,15,23,59),1.1),bar(Date.UTC(2024,2,18,0,0),1.2),bar(Date.UTC(2024,2,18,0,1),1.3)]
 expect(rolloverIndex(candles,0)).toBe(candles.length)
 expect(aggregateBidCandles(candles.slice(0,2),'H4').at(-1)?.close).toBe(1.2)
 expect(aggregateBidCandles(candles,'H4').at(-1)?.close).toBe(1.3)
})
