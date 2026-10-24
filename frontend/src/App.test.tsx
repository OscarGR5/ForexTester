import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { App } from './App'
it('opens in setup without mounting charts, trading controls or results', () => {
  const html = renderToStaticMarkup(<App/>)
  expect(html).toContain('Set up a backtest')
  expect(html).toContain('Load historical data')
  expect(html).toContain('Start backtest')
  expect(html).toContain('Through')
  expect(html).not.toContain('chart-canvas')
  expect(html).not.toContain('Trading journal')
  expect(html).not.toContain('>Buy<')
})
