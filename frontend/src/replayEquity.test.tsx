// @vitest-environment jsdom
import { StrictMode, act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { useReplay } from './useReplay'
import { useTrading } from './useTrading'
import { equityObservations } from './EquityChart'
import type { LegacyHistoryResponse as HistoryResponse } from './history'

Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true})
const base=Date.UTC(2024,0,9)
const history:HistoryResponse={symbol:'EURUSD',resolution:'M1',from:'2024-01-08',to:'2024-01-10',
 bid:Array.from({length:212},(_,i)=>({timestamp:base+(i-10)*60_000,open:1.1,high:1.1005,low:i===65?1.097:1.0995,close:1.1})),
 ask:Array.from({length:212},(_,i)=>({timestamp:base+(i-10)*60_000,open:1.1002,high:1.1007,low:i===65?1.0972:1.0997,close:1.1002}))}

async function run(speed:1|10|100) {
 let replay!:ReturnType<typeof useReplay>,trading!:ReturnType<typeof useTrading>
 let source:HistoryResponse|null=history
 function Harness(){replay=useReplay(source?.bid??null,10);trading=useTrading(source,replay);return null}
 const root=createRoot(document.createElement('div'))
 try {
  await act(async()=>root.render(<StrictMode><Harness/></StrictMode>))
  await act(async()=>trading.configureCommission({roundTripUsdPerLot:7}))
  await act(async()=>replay.start())
  expect(replay.timestamp).toBe(base);expect(replay.visible).toHaveLength(11)
  expect(trading.state.observedTimestamp).toBe(base);expect(trading.equity.count).toBe(1)
  expect(equityObservations(trading.equity)[0].timestamp).toBe(base)
  await act(async()=>{trading.enter('buy',1,1.098);trading.enter('buy',0.5,1.098)})
  await act(async()=>replay.setSpeed(speed))
  await act(async()=>replay.play())
  for(let tick=0;tick<Math.ceil(201/speed);tick++)await act(async()=>vi.advanceTimersByTime(250))
  expect(replay.status).toBe('Complete');expect(trading.state.closed).toHaveLength(2)
  expect(trading.state.closed.map(p=>p.exitTime)).toEqual([base+55*60_000,base+55*60_000])
  expect(trading.equity.count).toBe(202)
  const result={closed:trading.state.closed,equity:equityObservations(trading.equity),max:trading.equity.maxDrawdownUsd}
  await act(async()=>replay.restart())
  expect(trading.state.closed).toHaveLength(0);expect(trading.equity.count).toBe(1)
  expect(replay.timestamp).toBe(base)
  source={...history,bid:[...history.bid]}
  await act(async()=>root.render(<StrictMode><Harness/></StrictMode>))
  expect(replay.status).toBe('Ready');expect(trading.equity.count).toBe(0)
  return result
 } finally {await act(async()=>root.unmount())}
}

describe('causal batched replay and equity under StrictMode',()=>{
 it('produces identical fills, fees, every equity point and drawdown at 1×, 10× and 100×',async()=>{
  vi.useFakeTimers({toFake:['setInterval','clearInterval']})
  try {const normal=await run(1);expect(await run(10)).toEqual(normal);expect(await run(100)).toEqual(normal)}
  finally {vi.useRealTimers()}
 })
})

it('keeps same-candle stops, weekend gap fills, setup grouping and missing-ask equity identical at every speed', async () => {
 const shifted:HistoryResponse={...history,
  bid:history.bid.map((bar,i)=>({...bar,timestamp:bar.timestamp+(i>=60?172800000:0),low:i===11?1.097:1.0995,
   ...(i===60?{open:1.1078,high:1.1088,low:1.1073,close:1.1078}:{})})),
  ask:history.ask.flatMap((bar,i)=>i===30||i===59?[]:[{...bar,timestamp:bar.timestamp+(i>=60?172800000:0),low:1.0997,high:i===11?1.104:bar.high,
   ...(i===60?{open:1.108,high:1.109,low:1.1075,close:1.108}:{})}])}
 async function simulate(speed:1|10|100) {
  let replay!:ReturnType<typeof useReplay>,trading!:ReturnType<typeof useTrading>
  function Harness(){replay=useReplay(shifted.bid,10);trading=useTrading(shifted,replay);return null}
  const root=createRoot(document.createElement('div'))
  try {
   await act(async()=>root.render(<StrictMode><Harness/></StrictMode>))
   await act(async()=>trading.configureCommission({roundTripUsdPerLot:7}))
   await act(async()=>replay.start())
   await act(async()=>trading.enter('sell',.1,1.102))
   await act(async()=>trading.enter('sell',.2,1.106,trading.state.pending[0].setupId))
   await act(async()=>replay.setSpeed(speed));await act(async()=>replay.play())
   for(let i=0;i<Math.ceil(201/speed);i++)await act(async()=>vi.advanceTimersByTime(250))
   const points=equityObservations(trading.equity)
   expect(trading.state.closed.map(p=>p.exitPrice)).toEqual([1.102,1.108])
   expect(trading.state.closed[0].entryTime).toBe(trading.state.closed[0].exitTime)
   expect(trading.state.closed[1].exitTime).toBe(shifted.bid[60].timestamp)
   expect(trading.state.setups).toHaveLength(1)
   expect(points).toHaveLength(202);expect(points.filter(p=>p.equityUsd===null)).toHaveLength(2)
   expect(points.find(p=>p.timestamp===shifted.bid[60].timestamp)!.clockGap).toBe(true)
   return {state:trading.state,points,drawdown:trading.equity.maxDrawdownUsd}
  } finally {await act(async()=>root.unmount())}
 }
 vi.useFakeTimers({toFake:['setInterval','clearInterval']})
 try {const normal=await simulate(1);expect(await simulate(10)).toEqual(normal);expect(await simulate(100)).toEqual(normal)}
 finally {vi.useRealTimers()}
})
