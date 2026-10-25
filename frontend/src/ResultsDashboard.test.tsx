// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ResultsDashboard } from './ResultsDashboard'
import { SetupRChart } from './ResultsCharts'
import { resultsFixture } from '../../tests/resultsFixture'
import { createEquityLedger } from './equity'
import { createTradingState } from './trading'
import { journalCsv } from './journalCsv'
import { JOURNAL_CSV_HEADERS } from './journalCsv'
import { completedSetups, setupPerformance } from './resultsAnalytics'
import { rValue } from './resultsFormatting'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let host: HTMLDivElement, root: ReturnType<typeof createRoot> | undefined
async function render(element: React.ReactNode) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root!.render(<StrictMode>{element}</StrictMode>)) }
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent === label)!

it('renders all six metrics, four chart areas and collapsed setup details with one combined row per setup', async () => {
  const fixture = resultsFixture('unfinished'), { trading: state, replay } = fixture.snapshot.checkpoint
  const save = vi.fn()
  await render(<ResultsDashboard state={state} ledger={fixture.snapshot.ledger} start={replay.startTimestamp} endpoint={replay.timestamp} singlePrice onSave={save} />)
  expect(host.querySelectorAll('.results-primary-metrics > div')).toHaveLength(6)
  expect(host.querySelectorAll('.results-chart-panel')).toHaveLength(4)
  expect(host.querySelector('.results-navigation')).toBeNull(); expect(host.querySelector('[aria-label="Statistics scope"]')).toBeNull()
  const breakdown = host.querySelector<HTMLDetailsElement>('.results-breakdown')!
  expect(breakdown.open).toBe(false); expect(host.textContent).toContain('1 open positions · 1 pending entries · 1 partially completed setups')
  const rows = host.querySelectorAll('[data-setup-id]'); expect(rows).toHaveLength(2)
  expect(rows[0].textContent).toContain('partially closed'); expect(rows[0].textContent).toContain('Partial realized PnL'); expect(rows[0].textContent).toContain('N/A')
  await act(async () => { breakdown.open = true; rows[0].querySelector('button')!.click() })
  const details = host.querySelectorAll('.position-detail'); expect(details).toHaveLength(2)
  for (const position of [...state.positions, ...state.closed]) {
    expect(host.querySelector(`[aria-label="Position details ${position.id}"]`)?.textContent).toContain(position.id)
    expect(host.querySelector(`[aria-label="Position details ${position.id}"]`)?.textContent).toContain('Original gross risk')
  }
  expect(host.querySelector('textarea')).toBeNull(); expect(host.textContent).toContain('SL changed')
  expect(host.querySelectorAll('.results-primary-metrics dd > span')[1].textContent).toBe('N/A')
  await act(async () => button('Save now').click()); expect(save).toHaveBeenCalledOnce()
  expect(state.closed).toHaveLength(1); expect(state.positions).toHaveLength(1); expect(state.pending).toHaveLength(1)
})

it('keeps CSV schema, metadata and formula safety through the header export action', async () => {
  const { snapshot } = resultsFixture('unfinished'), { trading: state, replay } = snapshot.checkpoint
  const create = vi.fn(() => 'blob:fixture'), revoke = vi.fn(), click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }))
  await render(<ResultsDashboard state={state} ledger={snapshot.ledger} start={replay.startTimestamp} endpoint={replay.timestamp} singlePrice onSave={() => {}} />)
  await act(async () => button('Export trades').click())
  expect(click).toHaveBeenCalledOnce(); expect(create).toHaveBeenCalledOnce()
  const csv = journalCsv(state)
  expect(csv.split('\r\n')[0]).toBe(JOURNAL_CSV_HEADERS.join(','))
  expect(csv).toContain("'=Stored note remains CSV-safe")
})

it('shows honest empty statistics, recorded equity and no charts with invalid coordinates', async () => {
  const state = createTradingState(), ledger = createEquityLedger(state.account.referenceBalance)
  await render(<ResultsDashboard state={state} ledger={ledger} start={Date.UTC(2024, 0, 1)} endpoint={null} singlePrice={false} onSave={() => {}} />)
  expect(host.textContent).toContain('No completed setups yet.'); expect(host.textContent).toContain('No M1 equity observations recorded.')
  expect(button('Export trades').disabled).toBe(true); expect(host.textContent).not.toMatch(/NaN|undefined/)
  expect(host.querySelector('.results-breakdown')!.textContent).toContain('No setups recorded.')
})

it('keeps setup scope fixed despite position preferences and provides keyboard synchronized equity/drawdown hover and units', async () => {
  const { snapshot } = resultsFixture('populated'), { trading: state, replay } = snapshot.checkpoint
  const stats = setupPerformance(completedSetups(state), state.account.referenceBalance)
  await render(<ResultsDashboard state={state} ledger={snapshot.ledger} start={replay.startTimestamp} endpoint={replay.timestamp} singlePrice onSave={() => {}} />)
  expect(host.querySelector('.results-primary-metrics')!.textContent).toContain(rValue(stats.totalNetR))
  expect(state.closed.length).toBeGreaterThan(stats.count)
  const equity = host.querySelector<SVGSVGElement>('.results-timeline')!
  await act(async () => { equity.focus(); equity.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })) })
  expect(host.querySelectorAll('.results-chart-readout time')).toHaveLength(2)
  expect(host.querySelectorAll('.results-crosshair')).toHaveLength(2)
  await act(async () => button('USD').click())
  expect(host.querySelector('.results-timeline')!.getAttribute('aria-label')).toContain('in USD')
  expect(button('USD').getAttribute('aria-pressed')).toBe('true')
})

it('pages through every R outcome, preserving zero and unavailable bars and deterministic setup identity', async () => {
  const observations = Array.from({ length: 83 }, (_, i) => ({ id: `setup-${i}`, netPnlUsd: i === 1 ? 0 : i % 2 ? -20 : 10, initialRiskUsd: i === 2 ? 0 : 10, grossPnlUsd: 10, totalCommissionUsd: 0, entryTime: 0, exitTime: i * 60000 }))
  await render(<SetupRChart observations={observations} />)
  expect(host.querySelectorAll('rect')).toHaveLength(40); expect(host.querySelectorAll('.results-r-zero')).toHaveLength(2)
  const seen = new Set<string>()
  for (let page = 0; page < 3; page++) {
    for (const bar of host.querySelectorAll('rect')) seen.add(bar.getAttribute('aria-label')!.split(' · ')[0])
    if (page < 2) await act(async () => button('Next').click())
  }
  expect(seen.size).toBe(83); expect(button('Next').disabled).toBe(true)
})
