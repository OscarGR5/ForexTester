import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { App } from './App'

describe('application shell', () => {
  it('shows the title and chart placeholder', () => {
    const html = renderToStaticMarkup(<App />)
    expect(html).toContain('ForexTester')
    expect(html).toContain('Chart workspace')
  })
})
