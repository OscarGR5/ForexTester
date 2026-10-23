// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import type { Candle } from './history'
import { useReplay } from './useReplay'

it('steps directly through missing minutes, weekend closures, and UTC day boundaries', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const source: Candle[] = [
    Date.UTC(2024, 0, 12, 21, 58), Date.UTC(2024, 0, 12, 22),
    Date.UTC(2024, 0, 14, 22), Date.UTC(2024, 0, 15),
  ].map((timestamp) => ({ timestamp, open: 1, high: 2, low: 1, close: 1.5 }))
  let replay!: ReturnType<typeof useReplay>
  function Harness() { replay = useReplay(source); return null }
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(async () => root.render(<Harness />))
    await act(async () => replay.start())
    for (let index = 0; index < source.length; index++) {
      expect(replay.timestamp).toBe(source[index].timestamp)
      expect(replay.visible).toEqual(source.slice(0, index + 1))
      if (index < source.length - 1) await act(async () => replay.next())
    }
    expect(replay.status).toBe('Complete')
    await act(async () => replay.next())
    expect(replay.revealed).toBe(4)
  } finally {
    await act(async () => root.unmount())
  }
})
