// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { fixtureHistory } from '../../tests/databentoFixture'
import { useReplay } from './useReplay'
import { useTrading } from './useTrading'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
it.each([1,10,100] as const)('blocks %i× playback before the contract switch, preserving two positions and equity', async speed => {
  vi.useFakeTimers()
  const history = fixtureHistory('2024-01-08','2024-01-12','2024-01-10')
  const root = createRoot(document.createElement('div'))
  let replay!: ReturnType<typeof useReplay>, trading!: ReturnType<typeof useTrading>
  function Harness() { replay = useReplay(history.candles); trading = useTrading(history,replay); return null }
  try {
    await act(async()=>root.render(<StrictMode><Harness/></StrictMode>))
    await act(async()=>{ replay.start(); replay.setSpeed(speed) })
    await act(async()=>{ trading.enter('buy',.01,1.09); trading.enter('sell',.01,1.11) })
    await act(async()=>replay.play())
    await act(async()=>vi.advanceTimersByTime(250))
    expect(replay.blocked).toBe(true);expect(replay.playing).toBe(false);expect(replay.canNext).toBe(false)
    expect(trading.state.positions).toHaveLength(2);expect(trading.state.closed).toHaveLength(0)
    const timestamp=trading.state.observedTimestamp, count=trading.equity.count
    await act(async()=>{replay.next();replay.play();vi.advanceTimersByTime(5000)})
    expect(trading.state.observedTimestamp).toBe(timestamp);expect(trading.equity.count).toBe(count)
    expect(trading.permission.hasFuture).toBe(false)
  } finally {await act(async()=>root.unmount());vi.useRealTimers()}
})
