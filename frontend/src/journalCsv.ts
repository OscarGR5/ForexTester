import { executedPositions, isClosed, netR, positionStatus, setupMetadataMap } from './analytics'
import type { TradingState } from './trading'

export const JOURNAL_CSV_HEADERS = ['setup_id', 'position_id', 'symbol', 'direction', 'volume_lots', 'entry_timestamp_utc', 'entry_price',
  'exit_timestamp_utc', 'exit_price', 'exit_reason', 'initial_sl', 'final_sl', 'original_risk_usd', 'gross_pnl_usd',
  'entry_commission_usd', 'exit_commission_usd', 'total_commission_usd', 'net_pnl_usd', 'net_r', 'setup_label', 'setup_tag',
  'setup_notes', 'status', 'coverage_warnings'] as const

// Quoting alone does not stop Excel/Sheets from executing a user-entered formula.
export function safeSpreadsheetText(value: string): string {
  return /^[\s\u0000-\u001f]*[=+\-@]/u.test(value) ? `'${value}` : value
}
function cell(value: string | number | null): string {
  return value === null ? '' : `"${String(value).replaceAll('"', '""')}"`
}

export function journalCsv(state: TradingState): string {
  const metadata = setupMetadataMap(state.setups)
  const rows = executedPositions(state).map((position) => {
    const setup = metadata.get(position.setupId)
    const closed = isClosed(position) ? position : null
    return [position.setupId, position.id, 'EURUSD', position.direction, position.lots, new Date(position.entryTime).toISOString(), position.entryPrice,
      closed ? new Date(closed.exitTime).toISOString() : null, closed?.exitPrice ?? null, closed?.exitReason ?? null,
      position.initialStopPrice, position.stopPrice, position.initialRiskUsd, closed?.grossPnlUsd ?? null,
      position.entryCommissionUsd, closed?.exitCommissionUsd ?? null, closed?.totalCommissionUsd ?? null, closed?.netPnlUsd ?? null,
      closed ? netR(closed.netPnlUsd, closed.initialRiskUsd) : null,
      safeSpreadsheetText(setup?.title ?? ''), safeSpreadsheetText(setup?.tag ?? ''), safeSpreadsheetText(setup?.notes ?? ''),
      positionStatus(position), JSON.stringify(position.coverageWarnings.map((warning) => ({ ...warning,
        from: new Date(warning.from).toISOString(), to: new Date(warning.to).toISOString() })))].map(cell).join(',')
  })
  return [JOURNAL_CSV_HEADERS.join(','), ...rows].join('\r\n') + '\r\n'
}

export function downloadJournalCsv(state: TradingState): void {
  const url = URL.createObjectURL(new Blob([journalCsv(state)], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `forextester-journal-session-${state.session}.csv`
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
