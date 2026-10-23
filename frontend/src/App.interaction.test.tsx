// @vitest-environment jsdom
import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createChart } from 'lightweight-charts'
import { App } from './App'

vi.mock('lightweight-charts', () => ({
  CandlestickSeries: {}, ColorType: { Solid: 'solid' },
  createChart: vi.fn(() => {
    let range = { from: 0, to: 2 }
    const scale = { getVisibleLogicalRange: () => range, fitContent: vi.fn(),
      setVisibleLogicalRange: (next: typeof range) => { range = next },
      subscribeVisibleLogicalRangeChange: vi.fn(), unsubscribeVisibleLogicalRangeChange: vi.fn() }
    return {
      addSeries: () => ({ setData: vi.fn() }), remove: vi.fn(),
      timeScale: () => scale,
      subscribeCrosshairMove: vi.fn(), unsubscribeCrosshairMove: vi.fn(),
      setCrosshairPosition: vi.fn(), clearCrosshairPosition: vi.fn(),
    }
  }),
}))

const history = {
  symbol: 'EURUSD', resolution: 'M1', from: '2024-01-09', to: '2024-01-10',
  bid: [0, 60, 120, 180, 240].map((minute) => ({ timestamp: Date.UTC(2024, 0, 9) + minute * 60_000,
    open: 1.1, high: 1.2, low: 1, close: 1.15 })), ask: [],
}

let host: HTMLDivElement
let root: Root
let rootMounted: boolean
let request: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  rootMounted = true
  request = vi.fn().mockImplementation(async (path: string) => {
    const params = new URL(path, 'http://test.local').searchParams
    const from = params.get('from')!
    const shift = Date.parse(`${from}T00:00:00Z`) - Date.UTC(2024, 0, 9)
    return new Response(JSON.stringify({ ...history, from, to: params.get('to'),
      bid: history.bid.map((candle) => ({ ...candle, timestamp: candle.timestamp + shift })) }), { status: 200 })
  })
  vi.stubGlobal('fetch', request)
})

afterEach(async () => {
  if (rootMounted) await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

async function click(input: HTMLInputElement) {
  await act(async () => input.click())
}

async function selectTimeframe(index: number, value: string) {
  const select = host.querySelectorAll<HTMLSelectElement>('select')[index]
  await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })) })
}

describe('chart layout controls', () => {
  it('removes every chart and subscription under React StrictMode cleanup', async () => {
    await act(async () => root.render(<StrictMode><App /></StrictMode>))
    await click(host.querySelector<HTMLInputElement>('input[value="3"]')!)
    await act(async () => root.unmount())
    rootMounted = false
    const charts = vi.mocked(createChart).mock.results.map((result) => result.value)
    expect(charts.length).toBeGreaterThan(3)
    for (const chart of charts) {
      expect(chart.remove).toHaveBeenCalledTimes(1)
      expect(chart.timeScale().unsubscribeVisibleLogicalRangeChange).toHaveBeenCalledTimes(1)
      expect(chart.unsubscribeCrosshairMove).toHaveBeenCalledTimes(1)
    }
  })

  it('selects timeframes independently and preserves them across 1, 2, and 3 chart layouts without downloading again', async () => {
    await act(async () => root.render(<App />))
    expect(host.querySelectorAll('.chart-pane')).toHaveLength(1)
    await click(host.querySelector<HTMLInputElement>('input[value="2"]')!)
    expect(host.querySelectorAll('.chart-pane')).toHaveLength(2)
    await selectTimeframe(0, 'M5')
    await selectTimeframe(1, 'H1')
    expect([...host.querySelectorAll<HTMLSelectElement>('select')].map((select) => select.value)).toEqual(['M5', 'H1'])
    await click(host.querySelector<HTMLInputElement>('input[value="3"]')!)
    await selectTimeframe(0, 'M15')
    await selectTimeframe(2, 'H4')
    expect([...host.querySelectorAll<HTMLSelectElement>('select')].map((select) => select.value)).toEqual(['M15', 'H1', 'H4'])
    await click(host.querySelector<HTMLInputElement>('input[value="1"]')!)
    await click(host.querySelector<HTMLInputElement>('input[value="3"]')!)
    expect([...host.querySelectorAll<HTMLSelectElement>('select')].map((select) => select.value)).toEqual(['M15', 'H1', 'H4'])
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('uses one date request for all displayed charts', async () => {
    await act(async () => root.render(<App />))
    await click(host.querySelector<HTMLInputElement>('input[value="3"]')!)
    const start = host.querySelector<HTMLInputElement>('input[aria-label="Start date"]')!
    const end = host.querySelector<HTMLInputElement>('input[aria-label="End date"]')!
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      set.call(start, '2024-01-10')
      start.dispatchEvent(new Event('input', { bubbles: true }))
      set.call(end, '2024-01-11')
      end.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[1][0]).toContain('from=2024-01-10&to=2024-01-11')
    expect(host.querySelectorAll('.chart-pane')).toHaveLength(3)
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })
})
