import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { diskApiFixture } from '../../tests/diskApiFixture.js'
import { fixtureHistory } from '../../tests/databentoFixture.js'
import { DiskSessionStore } from '../../frontend/src/diskSessionStore.js'
import { historyFingerprint, validateHistoryCheckpoint, validatedHistory } from '../../frontend/src/sessionCodec.js'
import { createEquityLedger, recordEquity } from '../../frontend/src/equity.js'
import { createTradingState, observeCandle, type TradingState } from '../../frontend/src/trading.js'
import { sessionSimulation } from '../../frontend/src/sessionFixtures.js'
import { equitySummary, type SessionSnapshot } from '../../frontend/src/sessionTypes.js'
import { historyCandles } from '../../frontend/src/history.js'
let disk: Awaited<ReturnType<typeof diskApiFixture>>
beforeEach(async () => { disk = await diskApiFixture(); vi.stubGlobal('fetch', disk.fetch) })
afterEach(async () => { vi.unstubAllGlobals(); await disk.close() })
it('uploads and restores all 120 days through the real 64 MiB API without paid requests, including mappings and original OHLC', async () => {
  const history = validatedHistory({ ...fixtureHistory('2023-12-02', '2024-03-31', '2024-03-18', true), tradingFrom: '2024-01-01' })
  const id = await historyFingerprint(history), store = new DiskSessionStore(), ledger = createEquityLedger(100000)
  await store.cacheHistory(id, history)
  const snapshot: SessionSnapshot = { ledger, checkpoint: { lifecycle: 'setup', trading: { ...createTradingState(), symbol: '6E' }, equity: equitySummary(ledger), executionCursor: 0,
    replay: { started: false, index: null, timestamp: null, startIndex: 30 * 1440, startTimestamp: Date.parse('2024-01-01'), speed: 100, complete: false, playing: false }, workspace: sessionSimulation().snapshot().checkpoint.workspace } }
  const saved = await store.save({ id: crypto.randomUUID(), name: '120-day single-price dataset', createdAt: new Date().toISOString(), range: { from: history.tradingFrom, to: history.to }, historyId: id, totalCandles: historyCandles(history).length }, snapshot, null)
  const restored = await store.recover(saved.id, async () => { throw Error('Restoration must not download') })
  expect(restored.history).toEqual(history)
  expect(await historyFingerprint(restored.history)).toBe(id)
  expect(saved.symbol).toBe('6E'); expect(saved.totalCandles).toBe(172800)
  validateHistoryCheckpoint(restored.record, restored.history)
  expect(Buffer.byteLength(JSON.stringify(history))).toBeLessThan(64 * 1024 * 1024)
}, 20000)
it('saves and resumes a late checkpoint from a 365-day local-Forex session',async()=>{
  const from='2024-01-01',tradingFrom='2024-01-31',to='2025-01-30'
  const candles=Array.from({length:395},(_,index)=>({timestamp:Date.parse(from)+index*86400000,open:1.1,high:1.1004,low:1.0996,close:1.1001}))
  const history=validatedHistory({format:'local-forex-v1',source:'local-parquet',symbol:'EURUSD',resolution:'M1',datasetId:'a'.repeat(64),sourceChecksum:'a'.repeat(64),normalizationVersion:1,
    priceModel:'single',priceBasis:'mid',executionModel:'single-price-m1-v1',timestampConvention:'utc-minute-open',instrument:{symbol:'EURUSD',baseCurrency:'EUR',quoteCurrency:'USD',pipSize:.0001,priceDecimals:7,unitsPerLot:100000},
    from,tradingFrom,to,candles})
  const startIndex=30,lateIndex=350
  let state:TradingState={...createTradingState(),symbol:'EURUSD',executionModel:'single-price-m1-v1'},ledger=createEquityLedger(100000)
  for(let index=startIndex;index<=lateIndex;index++){const previous=state;state=observeCandle(state,candles[index],undefined,'single');ledger=recordEquity(ledger,previous,state)}
  const snapshot:SessionSnapshot={ledger,checkpoint:{lifecycle:'trading',trading:state,equity:equitySummary(ledger),executionCursor:lateIndex+1,
    replay:{started:true,index:lateIndex,timestamp:candles[lateIndex].timestamp,startIndex,startTimestamp:candles[startIndex].timestamp,speed:100,complete:false,playing:false},workspace:sessionSimulation().snapshot().checkpoint.workspace}}
  const id=await historyFingerprint(history),store=new DiskSessionStore()
  await store.cacheHistory(id,history)
  const saved=await store.save({id:crypto.randomUUID(),name:'365-day local session',createdAt:new Date().toISOString(),range:{from:tradingFrom,to},historyId:id,totalCandles:candles.length},snapshot,null)
  const restored=await store.recover(saved.id)
  expect(restored.record.range).toEqual({from:tradingFrom,to});expect(restored.checkpoint.replay.index).toBe(lateIndex)
  expect(restored.ledger.count).toBe(lateIndex-startIndex+1);expect(restored.checkpoint.equity).toEqual(equitySummary(ledger))
  expect(restored.history).toEqual(history)
})

it.each([1, 2, 3, 4] as const)('restores a %i-chart zero-indicator session with no warm-up and preserves its commission', async chartCount => {
  const from='2024-01-01',to='2024-01-02'
  const history=validatedHistory({format:'local-forex-v1',source:'local-parquet',symbol:'EURUSD',resolution:'M1',datasetId:'a'.repeat(64),sourceChecksum:'a'.repeat(64),normalizationVersion:1,
    priceModel:'single',priceBasis:'mid',executionModel:'single-price-m1-v1',timestampConvention:'utc-minute-open',instrument:{symbol:'EURUSD',baseCurrency:'EUR',quoteCurrency:'USD',pipSize:.0001,priceDecimals:7,unitsPerLot:100000},
    from,tradingFrom:from,to,candles:Array.from({length:4},(_,index)=>({timestamp:Date.parse(from)+index*60000,open:1.1,high:1.1004,low:1.0996,close:1.1001}))})
  const ledger=createEquityLedger(100000)
  const workspace=sessionSimulation().snapshot().checkpoint.workspace
  workspace.chartCount=chartCount
  if(chartCount===4) { workspace.timeframes.push('M1'); workspace.indicators.push(structuredClone(workspace.indicators[0])) }
  for(const pane of workspace.indicators) for(const settings of Object.values(pane)) for(const group of Object.values(settings!)) group.enabled=false
  const snapshot:SessionSnapshot={ledger,checkpoint:{lifecycle:'setup',trading:{...createTradingState(),executionModel:'single-price-m1-v1',commission:{roundTripUsdPerLot:3.75}},equity:equitySummary(ledger),executionCursor:0,
    replay:{started:false,index:null,timestamp:null,startIndex:0,startTimestamp:Date.parse(from),speed:1,complete:false,playing:false},workspace}}
  const id=await historyFingerprint(history),store=new DiskSessionStore()
  await store.cacheHistory(id,history)
  const saved=await store.save({id:crypto.randomUUID(),name:'No indicators',createdAt:new Date().toISOString(),range:{from,to},historyId:id,totalCandles:4},snapshot,null)
  const restored=await store.recover(saved.id)
  expect(restored.history).toEqual(history)
  expect(restored.checkpoint).toEqual(snapshot.checkpoint)
  expect(restored.checkpoint.trading.commission.roundTripUsdPerLot).toBe(3.75)
})
