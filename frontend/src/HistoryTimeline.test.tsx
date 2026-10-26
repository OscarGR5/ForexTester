import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { HistoryTimeline } from './HistoryTimeline'
import { shiftDate } from './workflow'

it('shows a 365-day selection and its pre-roll without clipping either timeline handle', () => {
  const calendar = { from: '2023-01-01', to: '2026-01-01', days: Array.from({ length: 395 }, (_, index) => ({
    date: shiftDate('2023-12-02', index), status: 'cached' as const, observations: 1, h4: [],
  })) }
  const html = renderToStaticMarkup(<HistoryTimeline calendar={calendar} range={{ from: '2024-01-01', to: '2024-12-31' }} disabled={false} onChange={() => {}} onEndChange={() => {}}/>)
  expect(html.match(/class="cached selected"/g)).toHaveLength(365)
  expect(html).toContain('aria-label="Historical start date"')
  expect(html).toContain('max="394" value="30"')
  expect(html).toContain('aria-label="Historical end date"')
  expect(html).toContain('max="394" value="394"')
  expect(html).toContain('2 Dec 2023')
  expect(html).toContain('30 Dec 2024')
})
