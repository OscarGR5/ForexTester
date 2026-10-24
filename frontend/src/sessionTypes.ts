import type { AnalyticsScope } from './analytics.js'
import type { UtcRange } from './chartSync.js'
import type { EquityLedger } from './equity.js'
import type { DateRange, Timeframe, ProviderProvenance } from './history.js'
import type { IndicatorSettings } from './indicatorSettings.js'
import type { TradingState } from './trading.js'

export const STORAGE_VERSION = 1 // IndexedDB structure is unchanged.
export const RECORD_VERSION = 2 // Legacy lifecycle records keep this format.
export const PROVIDER_RECORD_VERSION = 3
export type Lifecycle = 'setup' | 'trading' | 'finished'
export function lifecycleOf(checkpoint: SessionCheckpoint): Lifecycle {
  return checkpoint.lifecycle ?? (checkpoint.replay.complete ? 'finished' : checkpoint.replay.started ? 'trading' : 'setup')
}
export const EQUITY_CHUNK_SIZE = 1024
export interface ReplayCheckpoint {
  started: boolean
  index: number | null
  timestamp: number | null
  startIndex: number
  startTimestamp: number
  speed: 1 | 10 | 100
  complete: boolean
  playing: boolean
}
export interface WorkspaceSettings {
  chartCount: number
  timeframes: Timeframe[]
  indicators: Partial<Record<Timeframe, IndicatorSettings>>[]
  statisticsScope: AnalyticsScope
  journalScope: AnalyticsScope
  viewport: { range: UtcRange | null; following: boolean } | null
}
export type EquitySummary = Omit<EquityLedger, 'tail'>
export interface SessionCheckpoint {
  lifecycle?: Lifecycle // Absent only in v1; derived after its digest is verified.
  replay: ReplayCheckpoint
  executionCursor: number
  trading: TradingState
  equity: EquitySummary
  workspace: WorkspaceSettings
}
export interface SessionRecord {
  id: string
  name: string
  createdAt: string
  savedAt: string
  schemaVersion: number
  symbol: 'EURUSD'
  range: DateRange
  historyId: string
  provenance?: ProviderProvenance
  revision: number
  status: 'paused' | 'complete' | 'in-progress'
  completedSetups: number
  totalCandles: number
  checkpoint: SessionCheckpoint
  chunkHashes: string[]
  digest: string
}
export interface SessionSnapshot { checkpoint: SessionCheckpoint; ledger: EquityLedger }
export interface Hydration extends SessionSnapshot { record: SessionRecord }
export function equitySummary({ tail: _tail, ...summary }: EquityLedger): EquitySummary { return summary }
