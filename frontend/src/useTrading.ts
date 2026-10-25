import { performanceStart, performanceEnd, performanceCount } from './replayPerformance.js'
import type { Hydration } from './sessionTypes'
import { createEquityLedger, recordEquity, type EquityLedger } from './equity'
import type { CommissionConfig } from './commissions'
import type { AccountRisk, EntrySizing } from './risk'
import { useCallback, useMemo, useState } from 'react'
import { historyCandles, isSinglePrice, type HistoryResponse } from './history'
import { requestAutomaticEntry, cancelEntry, configureAccount, configureCommission, createTradingState, observeCandle, modifyStop, requestClose, requestEntry, updateSetupMetadata, type SetupMetadata, type Direction, type TradingPermission, type TradingState } from './trading'

interface ReplayClock { reviewing?: boolean; epoch: number; revealed: number; active: boolean; playing: boolean; complete: boolean; blocked?: boolean; startIndex?: number }
interface Session { history: HistoryResponse | null; epoch: number; processed: number; state: TradingState; equity: EquityLedger; actionVersion: number }

export function useTrading(history: HistoryResponse | null, replay: ReplayClock, restored?: Hydration | null) {
  const asks = useMemo(() => new Map(history && !isSinglePrice(history) ? history.ask.map((candle) => [candle.timestamp, candle]) : []), [history])
  const [session, setSession] = useState<Session>(() => ({ history, epoch: replay.epoch, processed: restored?.checkpoint.executionCursor ?? 0, state: restored?.checkpoint.trading ?? createTradingState(replay.epoch), equity: restored?.ledger ?? createEquityLedger(100_000), actionVersion: 0 }))
  let current = session
  if (session.history !== history || session.epoch !== replay.epoch) {
    current = restored && session.history !== history ? { history, epoch: replay.epoch, processed: restored.checkpoint.executionCursor, state: restored.checkpoint.trading, equity: restored.ledger, actionVersion: session.actionVersion + 1 } : { history, epoch: replay.epoch, processed: replay.active ? replay.startIndex ?? 0 : 0, state: createTradingState(replay.epoch, session.state.account, session.state.commission), equity: createEquityLedger(session.state.account.referenceBalance), actionVersion: session.actionVersion + 1 }
  }
  if (history && current.processed < replay.revealed) {
    const processing = performanceStart()
    let state = history && isSinglePrice(history) ? { ...current.state, symbol: '6E' as const } : current.state
    let equity = current.equity
    // React may combine many timer ticks into one render. Process the entire
    // newly revealed prefix, rather than filling at just the final rendered bar.
    for (let index = Math.max(current.processed, replay.startIndex ?? 0); index < replay.revealed; index++) {
      const bid = historyCandles(history)[index]
      const previous = state
      state = observeCandle(state, bid, asks.get(bid.timestamp), isSinglePrice(history) ? 'single' : 'bid-ask')
      equity = recordEquity(equity, previous, state)
    }
    performanceCount('execution.observations', replay.revealed - Math.max(current.processed, replay.startIndex ?? 0))
    performanceEnd('execution.equity', processing)
    current = { ...current, processed: replay.revealed, state, equity }
  }
  if (history && isSinglePrice(history) && current.state.symbol !== '6E') current = { ...current, state: { ...current.state, symbol: '6E' } }
  // Pure adjustment before children render, as with the replay dataset reset.
  // No effects/ref mutations: StrictMode can safely repeat this computation.
  if (current !== session) setSession(current)

  const permission: TradingPermission = { active: replay.active && !replay.reviewing, playing: replay.playing, hasFuture: !replay.complete && !replay.blocked }
  const update = (transition: (state: TradingState) => TradingState) => {
    setSession((previous) => ({ ...previous, state: transition(previous.state), actionVersion: previous.actionVersion + 1 }))
  }
  const updateSetup = useCallback((id: string, metadata: SetupMetadata) => {
    setSession((previous) => ({ ...previous, state: updateSetupMetadata(previous.state, id, metadata), actionVersion: previous.actionVersion + 1 }))
  }, [])
  return {
    actionVersion: current.actionVersion,
    executionCursor: current.processed,
    equity: current.equity,
    state: current.state,
    permission,
    enterAutomatic: (direction: Direction, sizing: EntrySizing, stopPrice: number) => update(state => requestAutomaticEntry(state, direction, sizing, stopPrice, permission)),
    enter: (direction: Direction, sizing: EntrySizing, stopPrice: number, setupId: string | null = null) => update((state) => requestEntry(state, direction, sizing, stopPrice, permission, setupId)),
    updateSetup,
    configure: (account: AccountRisk) => setSession((previous) => {
      const state = configureAccount(previous.state, account, permission)
      return { ...previous, state, actionVersion: previous.actionVersion + 1, equity: state !== previous.state ? createEquityLedger(state.account.referenceBalance) : previous.equity }
    }),
    configureCommission: (commission: CommissionConfig) => update((state) => configureCommission(state, commission, permission)),
    modifyStop: (id: string, price: number) => update((state) => modifyStop(state, id, price, permission)),
    cancel: (id: string) => update((state) => cancelEntry(state, id)),
    close: (id: string) => update((state) => requestClose(state, id, permission)),
  }
}
