import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { App } from './App'
it('hides setup until session discovery completes, without mounting charts or results', () => {
  const html = renderToStaticMarkup(<App/>)
  expect(html).toContain('Set up a backtest')
  expect(html).toContain('Checking local history')
  expect(html).not.toMatch(/Databento|Get more historical data|paid-download/)
  expect(html).not.toContain('datetime-local')
  expect(html).toContain('Start backtest')
  expect(html).toContain('Through')
  expect(html).toContain('365 days')
  expect(html).toContain('180 days')
  expect(html).toContain('Random Range')
  expect(html).toContain('maximum 365')
  expect(html).toMatch(/Round-trip commission[\s\S]*value="7"/)
  expect(html).toMatch(/name="chart-count" checked="" value="2"/)
  expect(html).toContain('Checking saved backtests')
  expect(html).toMatch(/class="workspace-controls"[^>]*hidden=""/)
  expect(html).not.toContain('chart-canvas')
  expect(html).not.toContain('Trading journal')
  expect(html).not.toContain('>Buy<')
})
