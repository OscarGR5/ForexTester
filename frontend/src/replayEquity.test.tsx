// @vitest-environment jsdom
import { StrictMode, act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { useReplay } from './useReplay'
import { useTrading } from './useTrading'
import { equityObservations } from './EquityChart'
import type { HistoryResponse } from './history'

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
