import { useMemo, useState } from 'react'
import type { HistoryResponse } from './history'
import { cancelEntry, createTradingState, observeCandle, requestClose, requestEntry, type Direction, type TradingPermission, type TradingState } from './trading'

interface ReplayClock { epoch: number; revealed: number; active: boolean; playing: boolean; complete: boolean }
interface Session { history: HistoryResponse | null; epoch: number; processed: number; state: TradingState }

export function useTrading(history: HistoryResponse | null, replay: ReplayClock) {
  const asks = useMemo(() => new Map(history?.ask.map((candle) => [candle.timestamp, candle])), [history])
  const [session, setSession] = useState<Session>(() => ({ history, epoch: replay.epoch, processed: 0, state: createTradingState(replay.epoch) }))
  let current = session
  if (session.history !== history || session.epoch !== replay.epoch) {
    current = { history, epoch: replay.epoch, processed: 0, state: createTradingState(replay.epoch) }
  }
  if (history && current.processed < replay.revealed) {
    let state = current.state
    // React may combine many timer ticks into one render. Process the entire
    // newly revealed prefix, rather than filling at just the final rendered bar.
    for (let index = current.processed; index < replay.revealed; index++) {
      const bid = history.bid[index]
      state = observeCandle(state, bid, asks.get(bid.timestamp))
    }
    current = { ...current, processed: replay.revealed, state }
  }
  // Pure adjustment before children render, as with the replay dataset reset.
  // No effects/ref mutations: StrictMode can safely repeat this computation.
  if (current !== session) setSession(current)

  const permission: TradingPermission = { active: replay.active, playing: replay.playing, hasFuture: !replay.complete }
  const update = (transition: (state: TradingState) => TradingState) => {
    setSession((previous) => ({ ...previous, state: transition(previous.state) }))
  }
  return {
    state: current.state,
    permission,
    enter: (direction: Direction, lots: number) => update((state) => requestEntry(state, direction, lots, permission)),
    cancel: (id: string) => update((state) => cancelEntry(state, id)),
    close: (id: string) => update((state) => requestClose(state, id, permission)),
  }
}
