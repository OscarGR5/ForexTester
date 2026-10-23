import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { App } from './App'

describe('application shell', () => {
  it('shows the default range and loading state', () => {
    const html = renderToStaticMarkup(<App />)
    expect(html).toContain('ForexTester')
    expect(html).toContain('EURUSD')
    expect(html).toContain('Bid')
    expect(html).toContain('value="2024-01-09"')
    expect(html).toContain('value="2024-01-10"')
    expect(html).toContain('Loading EURUSD M1 bid candles')
  })
})
