import { accountRiskError, exceedsRisk } from './risk.js'
import { commissionConfigError, perSideCommissionUsd } from './commissions.js'
import { combinedRisk, grossPnl, type TradingState } from './trading.js'
import { createEquityLedger, type EquityLedger, type EquityPoint } from './equity.js'
import { parseHistory, parseProvenance, TIMEFRAMES, validateDateRange } from './history.js'
import { PREROLL_DAYS, replayStartIndex, type LoadedHistory } from './historyLoader.js'
import { defaultIndicatorSettings, validateIndicatorSettings } from './indicatorSettings.js'
import { RECORD_VERSION, PROVIDER_RECORD_VERSION, type EquitySummary, type SessionRecord } from './sessionTypes.js'

export const corrupt = () => new Error('Saved session is corrupt or incomplete. The original data was kept. Retry recovery or explicitly delete this session.')
function requireValid(value: unknown): asserts value { if (!value) throw corrupt() }
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const positive = (value: unknown): value is number => finite(value) && value > 0
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const timestamp = (value: unknown): value is number => integer(value) && value % 60_000 === 0
const text = (value: unknown): value is string => typeof value === 'string'
const near = (a: number, b: number) => finite(a) && finite(b) && Math.abs(a - b) <= 1e-7 * Math.max(1, Math.abs(a), Math.abs(b))

export async function sha256(value: string | ArrayBuffer): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
export async function recordDigest(record: Omit<SessionRecord, 'digest'> | SessionRecord): Promise<string> {
  const { digest: _digest, ...payload } = record as SessionRecord
  return sha256(JSON.stringify(payload))
}
export function validatedHistory(value: LoadedHistory): LoadedHistory {
  requireValid(value && !validateDateRange({ from: value.tradingFrom, to: value.to }))
  requireValid(typeof value.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.from) && Date.parse(value.from) === Date.parse(value.tradingFrom) - PREROLL_DAYS * 86_400_000)
  return { ...parseHistory(value, { from: value.from, to: value.to }), tradingFrom: value.tradingFrom }
}
// Explicit little-endian IEEE-754 numbers, side lengths and UTC range form the
// canonical identity. Both independent sides, including gaps, participate.
export async function historyFingerprint(history: LoadedHistory): Promise<string> {
  const identity = history.provenance ? `v2/${history.provenance.provider}/${history.provenance.normalizationVersion}` : 'v1'
  const prefix = new TextEncoder().encode(`EURUSD/M1/${identity}/${history.from}/${history.tradingFrom}/${history.to}/`)
  const buffer = new ArrayBuffer(prefix.length + 16 + (history.bid.length + history.ask.length) * 40)
  new Uint8Array(buffer).set(prefix)
  const view = new DataView(buffer)
  let offset = prefix.length
  for (const side of [history.bid, history.ask]) {
    view.setFloat64(offset, side.length, true); offset += 8
    for (const bar of side) for (const key of ['timestamp', 'open', 'high', 'low', 'close'] as const) {
      view.setFloat64(offset, bar[key], true); offset += 8
    }
  }
  return sha256(buffer)
}

function validateTrading(state: TradingState) {
  requireValid(state && state.account && !accountRiskError(state.account) && state.commission && !commissionConfigError(state.commission))
  requireValid(integer(state.session) && integer(state.nextId) && state.nextId > 0 && integer(state.nextSetupId) && state.nextSetupId > 0)
  for (const key of ['pending', 'positions', 'closed', 'rejected', 'cancelled', 'setups'] as const) requireValid(Array.isArray(state[key]))
  requireValid(state.pending.length + state.positions.length <= 2)
  const setups = new Map(state.setups.map((setup) => [setup.id, setup]))
  requireValid(setups.size === state.setups.length)
  for (const setup of state.setups) requireValid(setup && setup.symbol === 'EURUSD' && ['buy', 'sell'].includes(setup.direction) &&
    [setup.id, setup.title, setup.tag, setup.notes].every(text) && setup.id.startsWith(`${state.session}-S`) &&
    integer(Number(setup.id.slice(`${state.session}-S`.length))) && Number(setup.id.slice(`${state.session}-S`.length)) < state.nextSetupId)
  const entries = [...state.pending, ...state.positions, ...state.closed, ...state.rejected, ...state.cancelled]
  requireValid(new Set(entries.map((entry) => entry.id)).size === entries.length)
  const clock = state.observedTimestamp
  requireValid(clock === null || timestamp(clock))
  const atOrBefore = (time: number) => timestamp(time) && clock !== null && time <= clock
  for (const entry of entries) {
    requireValid(entry && text(entry.id) && entry.id.startsWith(`${state.session}-`) && integer(Number(entry.id.slice(`${state.session}-`.length))) &&
      Number(entry.id.slice(`${state.session}-`.length)) > 0 && Number(entry.id.slice(`${state.session}-`.length)) < state.nextId)
    requireValid(setups.get(entry.setupId)?.direction === entry.direction && positive(entry.stopPrice) && atOrBefore(entry.requestedAt))
    requireValid(entry.mode === 'manual' ? positive(entry.lots) && entry.requestedRiskPercent === null && entry.requestedRiskUsd === null
      : entry.mode === 'risk' && positive(entry.requestedRiskPercent) && entry.requestedRiskPercent <= 100 && positive(entry.requestedRiskUsd) && (entry.lots === null || positive(entry.lots)))
  }
  for (const entry of state.rejected) requireValid(atOrBefore(entry.rejectedAt) && entry.rejectedAt > entry.requestedAt && text(entry.reason))
  for (const entry of state.cancelled) requireValid(atOrBefore(entry.cancelledAt) && entry.cancelledAt >= entry.requestedAt)
  for (const setup of setups.keys()) requireValid([...state.pending, ...state.positions, ...state.closed].filter((entry) => entry.setupId === setup).length <= 2)
  for (const position of [...state.positions, ...state.closed]) {
    requireValid(positive(position.lots) && positive(position.entryPrice) && positive(position.initialStopPrice) && positive(position.initialRiskUsd) && positive(position.initialRiskPercent) &&
      positive(position.referenceBalance) && atOrBefore(position.entryTime) && position.entryTime > position.requestedAt &&
      (position.closeRequestedAt === null || atOrBefore(position.closeRequestedAt) && position.closeRequestedAt >= position.entryTime) && atOrBefore(position.stopEffectiveAfter))
    requireValid(position.commission && !commissionConfigError(position.commission) && near(position.entryCommissionUsd, perSideCommissionUsd(position.lots, position.commission)))
    requireValid(position.direction === 'buy' ? position.initialStopPrice < position.entryPrice : position.initialStopPrice > position.entryPrice)
    requireValid(near(position.initialRiskUsd, Math.abs(position.entryPrice - position.initialStopPrice) * 100_000 * position.lots) &&
      near(position.initialRiskPercent, position.initialRiskUsd / position.referenceBalance * 100))
    requireValid(Array.isArray(position.stopModifications) && Array.isArray(position.coverageWarnings))
    let previous = position.initialStopPrice, lastTime = position.requestedAt
    for (const change of position.stopModifications) {
      requireValid(positive(change.oldPrice) && positive(change.newPrice) && change.oldPrice === previous && atOrBefore(change.timestamp) && change.timestamp >= position.entryTime && change.timestamp >= lastTime)
      previous = change.newPrice; lastTime = change.timestamp
    }
    requireValid(previous === position.stopPrice && position.stopEffectiveAfter === lastTime)
    for (const warning of position.coverageWarnings) requireValid(atOrBefore(warning.from) && atOrBefore(warning.to) && warning.from <= warning.to && ['bid', 'ask'].includes(warning.side) && ['clock_gap', 'missing_quote'].includes(warning.reason))
  }
  for (const trade of state.closed) requireValid(positive(trade.exitPrice) && atOrBefore(trade.exitTime) && trade.exitTime >= trade.entryTime &&
    ['manual', 'stop_loss'].includes(trade.exitReason) && (trade.exitReason === 'manual' ? trade.stopFillType === null : ['level', 'gap_open'].includes(trade.stopFillType!)) &&
    near(trade.grossPnlUsd, grossPnl(trade, trade.exitPrice).usd) && near(trade.exitCommissionUsd, perSideCommissionUsd(trade.lots, trade.commission)) &&
    near(trade.totalCommissionUsd, trade.entryCommissionUsd + trade.exitCommissionUsd) && near(trade.netPnlUsd, trade.grossPnlUsd - trade.totalCommissionUsd))
  const risk = combinedRisk(state)
  requireValid(!exceedsRisk(risk.usedUsd, risk.maximumUsd))
  if (clock === null) requireValid(!entries.length && !state.setups.length && state.quote === null)
  else {
    requireValid(state.quote && state.quote.bid)
    for (const bar of [state.quote.bid, state.quote.ask]) if (bar) requireValid(bar.timestamp === clock &&
      [bar.open, bar.high, bar.low, bar.close].every(positive) && bar.low <= Math.min(bar.open, bar.close) && bar.high >= Math.max(bar.open, bar.close))
  }
}

export async function validateRecord(record: SessionRecord): Promise<void> {
  if (![1, RECORD_VERSION, PROVIDER_RECORD_VERSION].includes(record?.schemaVersion)) throw new Error(`Unsupported saved-session schema version: ${record?.schemaVersion ?? 'missing'}. Data was kept; use a compatible application version.`)
  try {
    requireValid(text(record.id) && record.id.length > 0 && text(record.name) && record.name.trim().length > 0 && record.symbol === 'EURUSD' &&
      text(record.createdAt) && new Date(record.createdAt).toISOString() === record.createdAt && text(record.savedAt) && new Date(record.savedAt).toISOString() === record.savedAt && record.savedAt >= record.createdAt &&
      integer(record.revision) && record.revision > 0 && record.range && !validateDateRange(record.range) && /^[a-f0-9]{64}$/.test(record.historyId))
    requireValid(['paused', 'complete', 'in-progress'].includes(record.status) && integer(record.totalCandles) && integer(record.completedSetups))
    requireValid(Array.isArray(record.chunkHashes) && record.chunkHashes.every((hash) => /^[a-f0-9]{64}$/.test(hash)))
    requireValid(await recordDigest(record) === record.digest)
    requireValid(record.schemaVersion === PROVIDER_RECORD_VERSION ? !!parseProvenance(record.provenance) : record.provenance === undefined)
    const { replay, trading, equity, executionCursor, workspace } = record.checkpoint
    if (record.schemaVersion >= RECORD_VERSION) {
      const lifecycle = record.checkpoint.lifecycle
      requireValid(['setup', 'trading', 'finished'].includes(lifecycle!))
      requireValid(lifecycle === 'setup' ? !replay.started : replay.started)
      requireValid(lifecycle !== 'finished' || !replay.playing)
    }
    validateTrading(trading)
    requireValid(typeof replay.started === 'boolean' && typeof replay.playing === 'boolean' && typeof replay.complete === 'boolean' && [1, 10, 100].includes(replay.speed) &&
      integer(replay.startIndex) && timestamp(replay.startTimestamp) && replay.startTimestamp >= Date.parse(record.range.from) && replay.startTimestamp < Date.parse(record.range.to))
    requireValid(integer(executionCursor) && integer(equity.count))
    requireValid(replay.started ? integer(replay.index) && replay.index >= replay.startIndex && replay.index < record.totalCandles && timestamp(replay.timestamp) &&
      executionCursor === replay.index + 1 && equity.count === executionCursor - replay.startIndex && replay.timestamp === trading.observedTimestamp && replay.complete === (executionCursor === record.totalCandles)
      : replay.index === null && replay.timestamp === null && !replay.complete && !replay.playing && executionCursor === 0 && equity.count === 0 && trading.observedTimestamp === null)
    requireValid(record.status === (replay.complete ? 'complete' : replay.playing ? 'in-progress' : 'paused'))
    requireValid(record.completedSetups === trading.setups.filter((setup) => trading.closed.some((p) => p.setupId === setup.id) && ![...trading.pending, ...trading.positions].some((p) => p.setupId === setup.id)).length)
    requireValid([equity.cashUsd, equity.highWaterMarkUsd, equity.maxDrawdownUsd].every(finite) && equity.maxDrawdownUsd >= 0 && equity.highWaterMarkUsd >= trading.account.referenceBalance &&
      (equity.maxDrawdownPercent === null || finite(equity.maxDrawdownPercent) && equity.maxDrawdownPercent >= 0) && typeof equity.nonpositiveEquity === 'boolean' && integer(equity.missingCount))
    const cash = trading.account.referenceBalance + trading.closed.reduce((sum, p) => sum + p.netPnlUsd, 0) - trading.positions.reduce((sum, p) => sum + p.entryCommissionUsd, 0)
    requireValid(near(cash, equity.cashUsd))
    requireValid(workspace && [1, 2, 3].includes(workspace.chartCount) && Array.isArray(workspace.timeframes) && workspace.timeframes.length === 3 &&
      workspace.timeframes.every((tf) => TIMEFRAMES.includes(tf)) && Array.isArray(workspace.indicators) && workspace.indicators.length === 3 &&
      ['setups', 'positions'].includes(workspace.statisticsScope) && ['setups', 'positions'].includes(workspace.journalScope))
    workspace.indicators.forEach((settings, index) => {
      requireValid(settings && settings[workspace.timeframes[index]])
      for (const [tf, value] of Object.entries(settings)) {
        requireValid(TIMEFRAMES.includes(tf as typeof TIMEFRAMES[number]) && value)
        for (const [group, fields] of Object.entries(defaultIndicatorSettings())) {
          for (const [key, example] of Object.entries(fields)) requireValid(typeof (value as unknown as Record<string, Record<string, unknown>>)[group]?.[key] === typeof example)
        }
        requireValid(!validateIndicatorSettings(value!))
      }
    })
    const viewport = workspace.viewport
    if (viewport) requireValid(typeof viewport.following === 'boolean' && (viewport.range === null || finite(viewport.range.from) && finite(viewport.range.to) && viewport.range.from < viewport.range.to))
  } catch (error) { if (error instanceof Error && error.message === corrupt().message) throw error; throw corrupt() }
}

export function validateHistoryCheckpoint(record: SessionRecord, history: LoadedHistory) {
  requireValid(record.provenance?.provider === history.provenance?.provider && record.provenance?.normalizationVersion === history.provenance?.normalizationVersion && record.provenance?.version === history.provenance?.version)
  const { replay, trading } = record.checkpoint
  requireValid(history.tradingFrom === record.range.from && history.to === record.range.to && history.bid.length === record.totalCandles)
  requireValid(replay.startIndex === replayStartIndex(history.bid, replay.startTimestamp))
  if (replay.started) {
    const bid = history.bid[replay.index!], ask = history.ask.find((bar) => bar.timestamp === replay.timestamp) ?? null
    requireValid(bid?.timestamp === replay.timestamp && JSON.stringify(trading.quote) === JSON.stringify({ bid, ask }))
  }
}

// Visits only the unsaved suffix, plus at most one partial chunk. No recursive
// object traversal and no array copying proportional to the whole replay.
export function equitySuffix(ledger: EquityLedger, from: number): EquityPoint[] {
  const points = new Array<EquityPoint>(ledger.count - from)
  let node = ledger.tail
  for (let index = points.length - 1; index >= 0; index--) {
    if (!node) throw corrupt()
    points[index] = node.point; node = node.previous
  }
  return points
}
export function restoreEquity(points: readonly EquityPoint[], summary: EquitySummary, referenceBalance: number, initial?: EquityLedger): EquityLedger {
  const ledger = initial ? { ...initial } : createEquityLedger(referenceBalance)
  let previous = ledger.tail?.point.timestamp ?? -1
  for (const point of points) {
    requireValid(point && timestamp(point.timestamp) && point.timestamp > previous && finite(point.cashUsd) && typeof point.clockGap === 'boolean' &&
      Array.isArray(point.missingSides) && point.missingSides.length <= 2 && new Set(point.missingSides).size === point.missingSides.length && point.missingSides.every((side) => side === 'bid' || side === 'ask'))
    requireValid(point.clockGap === (previous >= 0 && point.timestamp > previous + 60_000))
    requireValid(point.missingSides.length ? point.unrealizedUsd === null && point.equityUsd === null && point.drawdownUsd === null && point.drawdownPercent === null
      : finite(point.unrealizedUsd) && finite(point.equityUsd) && near(point.equityUsd, point.cashUsd + point.unrealizedUsd))
    if (point.equityUsd !== null) {
      ledger.highWaterMarkUsd = Math.max(ledger.highWaterMarkUsd, point.equityUsd)
      requireValid(near(point.drawdownUsd!, ledger.highWaterMarkUsd - point.equityUsd))
      const percent = point.equityUsd > 0 && ledger.highWaterMarkUsd > 0 ? point.drawdownUsd! / ledger.highWaterMarkUsd * 100 : null
      requireValid(percent === null ? point.drawdownPercent === null : near(point.drawdownPercent!, percent))
      ledger.maxDrawdownUsd = Math.max(ledger.maxDrawdownUsd, point.drawdownUsd!)
      ledger.nonpositiveEquity ||= point.equityUsd <= 0
      ledger.maxDrawdownPercent = ledger.nonpositiveEquity ? null : Math.max(ledger.maxDrawdownPercent ?? 0, point.drawdownPercent ?? 0)
    }
    ledger.count++; ledger.cashUsd = point.cashUsd; ledger.missingCount += point.missingSides.length ? 1 : 0
    ledger.tail = { point, previous: ledger.tail }; previous = point.timestamp
  }
  for (const key of Object.keys(summary) as (keyof EquitySummary)[]) requireValid(typeof summary[key] === 'number' ? near(summary[key] as number, ledger[key] as number) : summary[key] === ledger[key])
  return ledger
}
