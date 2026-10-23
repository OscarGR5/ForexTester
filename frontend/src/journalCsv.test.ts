import { describe, expect, it } from 'vitest'
import { JOURNAL_CSV_HEADERS, journalCsv, safeSpreadsheetText } from './journalCsv'
import { cancelEntry, createTradingState, observeCandle, requestClose, requestEntry, updateSetupMetadata } from './trading'

const permission = { active: true, playing: false, hasFuture: true }
const base = Date.UTC(2024, 0, 9)
const candle = (minute: number, price: number) => ({ timestamp: base + minute * 60_000, open: price, close: price, high: price + 0.0001, low: price - 0.0001 })

// A CSV reader that handles embedded CR/LF, doubled quotes, and quoted commas.
function readCsv(csv: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], value = '', quoted = false
  for (let index = 0; index < csv.length; index++) {
    const char = csv[index]
    if (char === '"') {
      if (quoted && csv[index + 1] === '"') { value += '"'; index++ }
      else quoted = !quoted
    } else if (char === ',' && !quoted) { row.push(value); value = '' }
    else if (char === '\r' && csv[index + 1] === '\n' && !quoted) {
      row.push(value); rows.push(row); row = []; value = ''; index++
    } else value += char
  }
  return rows
}
function session() {
  let state = observeCandle(createTradingState(7), candle(0, 1.1), candle(0, 1.1002))
  state = requestEntry(state, 'buy', 0.012345, 1.09, permission)
  const setupId = state.pending[0].setupId
  state = requestEntry(state, 'buy', 0.02, 1.095, permission, setupId)
  state = observeCandle(state, candle(1, 1.1), candle(1, 1.1002))
  state = requestClose(state, state.positions[0].id, permission)
  state = observeCandle(state, candle(2, 1.1012345), candle(2, 1.1014345))
  state = updateSetupMetadata(state, setupId, { title: 'London, "pullback"', tag: '=SUM(1,2)', notes: 'Line one\r\nLine "two", comma\nLine three' })
  return state
}

describe('session journal CSV', () => {
  it('exports RFC-compatible text, UTC timestamps, original precision and setup metadata', () => {
    const state = session()
    const rows = readCsv(journalCsv(state))
    expect(rows[0]).toEqual([...JOURNAL_CSV_HEADERS])
    expect(rows).toHaveLength(3)
    expect(rows.every((row) => row.length === JOURNAL_CSV_HEADERS.length)).toBe(true)
    const [closed, open] = rows.slice(1).map((row) => Object.fromEntries(rows[0].map((key, index) => [key, row[index]])))
    expect(closed).toMatchObject({ setup_id: '7-S1', position_id: '7-1', symbol: 'EURUSD', volume_lots: '0.012345',
      entry_timestamp_utc: '2024-01-09T00:01:00.000Z', exit_timestamp_utc: '2024-01-09T00:02:00.000Z',
      exit_price: '1.1012345', initial_sl: '1.09', final_sl: '1.09', status: 'closed',
      setup_label: 'London, "pullback"', setup_tag: "'=SUM(1,2)", setup_notes: 'Line one\r\nLine "two", comma\nLine three' })
    expect(closed.net_pnl_usd).toBe(String(state.closed[0].netPnlUsd))
    expect(closed.net_r).toBe(String(state.closed[0].netPnlUsd / state.closed[0].initialRiskUsd))
    expect(open).toMatchObject({ position_id: '7-2', status: 'open', entry_commission_usd: '0',
      exit_timestamp_utc: '', exit_price: '', exit_reason: '', exit_commission_usd: '', total_commission_usd: '',
      gross_pnl_usd: '', net_pnl_usd: '', net_r: '' })
  })

  it.each(['=1+1', '+SUM(A1:A2)', '-1+2', '@SUM(A1:A2)', ' \t=1+1', '\r\n=HYPERLINK("x")'])('neutralizes formula text: %s', (value) => {
    expect(safeSpreadsheetText(value)).toBe(`'${value}`)
    const state = session()
    const updated = updateSetupMetadata(state, state.setups[0].id, { title: value, tag: value, notes: value })
    const rows = readCsv(journalCsv(updated))
    for (const key of ['setup_label', 'setup_tag', 'setup_notes']) expect(rows[1][rows[0].indexOf(key)]).toBe(`'${value}`)
  })

  it('exports warnings with explicit UTC ranges and preserves pending-close status', () => {
    const state = session()
    state.positions[0].coverageWarnings = [{ side: 'ask', reason: 'clock_gap', from: base, to: base + 60_000 }]
    state.positions[0].closeRequestedAt = base + 120_000
    const rows = readCsv(journalCsv(state))
    const open = Object.fromEntries(rows[0].map((key, index) => [key, rows[2][index]]))
    expect(open.status).toBe('pending close')
    expect(JSON.parse(open.coverage_warnings)).toEqual([{ side: 'ask', reason: 'clock_gap', from: '2024-01-09T00:00:00.000Z', to: '2024-01-09T00:01:00.000Z' }])
  })

  it('excludes pending, cancelled and rejected requests and exports only headers for an empty session', () => {
    let state = observeCandle(createTradingState(), candle(0, 1.1), candle(0, 1.1002))
    state = requestEntry(state, 'buy', 0.01, 1.101, permission)
    state = observeCandle(state, candle(1, 1.1), candle(1, 1.1002))
    state = requestEntry(state, 'buy', 0.01, 1.09, permission)
    state = cancelEntry(state, state.pending[0].id)
    state = requestEntry(state, 'buy', 0.01, 1.09, permission)
    expect(readCsv(journalCsv(state))).toEqual([[...JOURNAL_CSV_HEADERS]])
    expect(journalCsv(createTradingState())).toBe(JOURNAL_CSV_HEADERS.join(',') + '\r\n')
  })
})
