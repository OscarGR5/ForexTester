// @vitest-environment jsdom
import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createChart, type CandlestickData, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts'
import { App } from './App'
import { TIMEFRAMES, TIMEFRAME_MS, type Candle } from './history'

vi.mock('lightweight-charts', () => ({
  CandlestickSeries: {}, LineSeries: {}, LineStyle: { Dashed: 2, Dotted: 1 }, ColorType: { Solid: 'solid' },
  createChart: vi.fn(() => {
    let range = { from: 0, to: 2 }
    const scale = { getVisibleLogicalRange: () => range, fitContent: vi.fn(),
      setVisibleLogicalRange: (next: typeof range) => { range = next },
      subscribeVisibleLogicalRangeChange: vi.fn(), unsubscribeVisibleLogicalRangeChange: vi.fn() }
    const makeSeries = () => {
    let values: CandlestickData<UTCTimestamp>[] = []
    return {
      setData: vi.fn((next: typeof values) => { values = next.map((candle) => ({ ...candle })) }),
      update: vi.fn((candle: typeof values[number], historical = false) => {
        if (historical) {
          const index = values.findIndex((value) => value.time === candle.time)
          if (index < 0) throw new Error('Historical time missing')
          values[index] = { ...candle }; return
        }
        const last = values.at(-1)
        if (last && candle.time < last.time) throw new Error('Out-of-order chart update')
        if (last?.time === candle.time) values[values.length - 1] = { ...candle }
        else values.push({ ...candle })
      }),
      data: () => values,
      attachPrimitive: vi.fn(), detachPrimitive: vi.fn(), createPriceLine: vi.fn((options) => ({ applyOptions: vi.fn(), options: () => options })), removePriceLine: vi.fn(),
      priceScale: () => ({ applyOptions: vi.fn() }),
    }
    }
    return {
      addSeries: vi.fn(makeSeries), removeSeries: vi.fn(), remove: vi.fn(),
      panes: () => [{ setStretchFactor: vi.fn() }, { setStretchFactor: vi.fn() }],
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
let defaultStops = true

beforeEach(() => {
  defaultStops = true
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
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function click(input: HTMLInputElement | HTMLButtonElement) {
  if (defaultStops && ['Buy', 'Sell'].includes(input.textContent ?? '')) await setInput('SL price', input.textContent === 'Buy' ? '0.5' : '2')
  await act(async () => input.click())
}

async function selectTimeframe(index: number, value: string) {
  const select = host.querySelectorAll<HTMLSelectElement>('select')[index]
  await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })) })
}

describe('chart layout controls', () => {
  it('cancels pending animation-frame refreshes on unmount', async () => {
    const frames = new Map<number, FrameRequestCallback>()
    let nextId = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++nextId, callback)
      return nextId
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
    await act(async () => root.render(<App />))
    expect(frames.size).toBe(1)
    const [id, firstFrame] = [...frames][0]
    frames.delete(id)
    firstFrame(0)
    expect(frames.size).toBe(1)
    await act(async () => root.unmount())
    rootMounted = false
    expect(frames.size).toBe(0)
  })

  it('removes every chart and subscription under React StrictMode cleanup', async () => {
    await act(async () => root.render(<StrictMode><App /></StrictMode>))
    await click(host.querySelector<HTMLInputElement>('input[value="3"]')!)
    await act(async () => root.unmount())
    rootMounted = false
    const charts = vi.mocked(createChart).mock.results.map((result) => result.value)
    expect(charts.length).toBeGreaterThan(3)
    for (const chart of charts) {
      expect(chart.remove).toHaveBeenCalledTimes(1)
      expect(chart.timeScale().unsubscribeVisibleLogicalRangeChange).toHaveBeenCalledTimes(vi.mocked(chart.timeScale().subscribeVisibleLogicalRangeChange).mock.calls.length)
      expect(chart.unsubscribeCrosshairMove).toHaveBeenCalledTimes(vi.mocked(chart.subscribeCrosshairMove).mock.calls.length)
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

function button(name: string) {
  return [...host.querySelectorAll('button')].find((element) => element.textContent === name)!
}

function chartSeries(index: number): ISeriesApi<'Candlestick', UTCTimestamp> {
  const chart = vi.mocked(createChart).mock.results[index].value
  return vi.mocked(chart.addSeries).mock.results[0].value
}

function replayStatus() { return host.querySelector('[aria-label="Replay status"]')!.textContent }
function progress() { return host.querySelector('[aria-label="Replay progress"]')!.textContent }

async function changeDates() {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    for (const [label, value] of [['Start date', '2024-01-10'], ['End date', '2024-01-11']]) {
      const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
      set.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
  })
  await click(button('Load Data'))
}

describe('shared market replay', () => {
  it('preserves full history until Start Replay, then reveals exactly one candle per manual step across gaps', async () => {
    await act(async () => root.render(<App />))
    expect(chartSeries(0).data()).toHaveLength(5)
    expect(replayStatus()).toBe('Ready')
    expect(button('Play').disabled).toBe(true)
    expect(button('Next Candle').disabled).toBe(true)
    await click(button('Start Replay'))
    expect(chartSeries(0).data()).toHaveLength(1)
    expect(replayStatus()).toBe('Paused')
    expect(progress()).toBe('1 / 5 candles')
    expect(host.querySelector('time')!.textContent).toBe('2024-01-09 00:00 UTC')
    expect(button('Start Replay').disabled).toBe(true)
    await click(button('Next Candle'))
    expect(chartSeries(0).data()).toHaveLength(2)
    expect(host.querySelector('time')!.textContent).toBe('2024-01-09 01:00 UTC')
    expect(progress()).toBe('2 / 5 candles')
    expect(createChart).toHaveBeenCalledTimes(1)
  })

  it('plays at the fixed interval, pauses without advancing, and stops at the final candle', async () => {
    await act(async () => root.render(<App />))
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 0))
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await click(button('Start Replay'))
    const series = chartSeries(0)
    const replacements = vi.mocked(series.setData).mock.calls.length
    const chart = vi.mocked(createChart).mock.results[0].value
    const subscriptions = vi.mocked(chart.subscribeCrosshairMove).mock.calls.length
    await click(button('Play'))
    expect(replayStatus()).toBe('Playing')
    expect(button('Next Candle').disabled).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
    await act(async () => vi.advanceTimersByTime(249))
    expect(progress()).toBe('1 / 5 candles')
    await act(async () => vi.advanceTimersByTime(1))
    expect(progress()).toBe('2 / 5 candles')
    await click(button('Pause'))
    expect(replayStatus()).toBe('Paused')
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => vi.advanceTimersByTime(1000))
    expect(progress()).toBe('2 / 5 candles')
    await click(button('Play'))
    // Multiple ticks may batch into one React frame; all intervening bars must reach the series.
    await act(async () => vi.advanceTimersByTime(750))
    expect(replayStatus()).toBe('Complete')
    expect(progress()).toBe('5 / 5 candles')
    expect(series.data()).toHaveLength(5)
    expect(vi.getTimerCount()).toBe(0)
    expect(button('Play').disabled).toBe(true)
    expect(button('Pause').disabled).toBe(true)
    expect(button('Next Candle').disabled).toBe(true)
    expect(createChart).toHaveBeenCalledTimes(1)
    expect(series.setData).toHaveBeenCalledTimes(replacements)
    expect(chart.subscribeCrosshairMove).toHaveBeenCalledTimes(subscriptions)
    expect(series.update).toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTime(2000))
    expect(progress()).toBe('5 / 5 candles')
  })

  it('restarts while playing and after completion, removing previously revealed candles', async () => {
    await act(async () => root.render(<App />))
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 0))
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await click(button('Start Replay'))
    await click(button('Play'))
    await act(async () => vi.advanceTimersByTime(500))
    await click(button('Restart'))
    expect(replayStatus()).toBe('Paused')
    expect(chartSeries(0).data()).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    await click(button('Play'))
    await act(async () => vi.advanceTimersByTime(1000))
    expect(replayStatus()).toBe('Complete')
    await click(button('Restart'))
    expect(progress()).toBe('1 / 5 candles')
    expect(replayStatus()).toBe('Paused')
    expect(createChart).toHaveBeenCalledTimes(1)
  })

  it('preserves the shared clock and timer when layouts and timeframes change', async () => {
    await act(async () => root.render(<App />))
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 0))
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await click(button('Start Replay'))
    await click(button('Play'))
    await act(async () => vi.advanceTimersByTime(500))
    await click(host.querySelector<HTMLInputElement>('input[value="2"]')!)
    await selectTimeframe(0, 'M5')
    await selectTimeframe(1, 'H1')
    expect(progress()).toBe('3 / 5 candles')
    expect(replayStatus()).toBe('Playing')
    expect(vi.getTimerCount()).toBe(1)
    await click(host.querySelector<HTMLInputElement>('input[value="3"]')!)
    await selectTimeframe(0, 'M15')
    await selectTimeframe(2, 'H4')
    expect(progress()).toBe('3 / 5 candles')
    expect(chartSeries(2).data()).toHaveLength(1)
    await click(host.querySelector<HTMLInputElement>('input[value="1"]')!)
    await click(host.querySelector<HTMLInputElement>('input[value="3"]')!)
    expect(progress()).toBe('3 / 5 candles')
    await act(async () => vi.advanceTimersByTime(250))
    expect(progress()).toBe('4 / 5 candles')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('cleans the running timer and every subscription on StrictMode unmount', async () => {
    await act(async () => root.render(<StrictMode><App /></StrictMode>))
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 0))
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await click(button('Start Replay'))
    await click(button('Play'))
    expect(vi.getTimerCount()).toBe(1)
    await act(async () => root.unmount())
    rootMounted = false
    expect(vi.getTimerCount()).toBe(0)
    for (const { value: chart } of vi.mocked(createChart).mock.results) {
      expect(chart.remove).toHaveBeenCalledTimes(1)
      expect(chart.unsubscribeCrosshairMove).toHaveBeenCalledTimes(vi.mocked(chart.subscribeCrosshairMove).mock.calls.length)
      expect(chart.timeScale().unsubscribeVisibleLogicalRangeChange).toHaveBeenCalledTimes(vi.mocked(chart.timeScale().subscribeVisibleLogicalRangeChange).mock.calls.length)
    }
  })

  it('resets playback on a different historical period and starts from the new dataset', async () => {
    await act(async () => root.render(<App />))
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 0))
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await click(button('Start Replay'))
    await click(button('Play'))
    await act(async () => vi.advanceTimersByTime(500))
    await changeDates()
    expect(replayStatus()).toBe('Ready')
    expect(progress()).toBe('0 / 5 candles')
    expect(vi.getTimerCount()).toBe(0)
    expect(chartSeries(0).data()).toHaveLength(5)
    await click(button('Start Replay'))
    expect(host.querySelector('time')!.textContent).toBe('2024-01-10 00:00 UTC')
    expect(chartSeries(0).data()).toHaveLength(1)
  })

  it('disables replay when loading, empty, or unavailable and completes a single-candle dataset', async () => {
    let resolve!: (response: Response) => void
    request.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done }))
    await act(async () => root.render(<App />))
    expect(button('Start Replay').disabled).toBe(true)
    await act(async () => resolve(new Response(JSON.stringify({ ...history, bid: [] }))))
    expect(button('Start Replay').disabled).toBe(true)
    request.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Unavailable' }), { status: 502 }))
    await click(button('Load Data'))
    expect(button('Start Replay').disabled).toBe(true)
    request.mockResolvedValueOnce(new Response(JSON.stringify({ ...history, bid: history.bid.slice(0, 1) })))
    await click(button('Retry'))
    await click(button('Start Replay'))
    expect(replayStatus()).toBe('Complete')
    expect(progress()).toBe('1 / 1 candles')
    expect(button('Play').disabled).toBe(true)
  })
})


describe('lookahead protection at the chart boundary', () => {
  for (const timeframe of TIMEFRAMES) {
    it(`renders only revealed OHLC in ${timeframe}, including partial H1/H4 buckets`, async () => {
      const base = Date.UTC(2024, 0, 9, 8)
      const source: Candle[] = [0, 2, 4, 5, 32, 59, 60, 152, 239, 240, 241].map((minute, index) => ({
        timestamp: base + minute * 60_000, open: 10 + index,
        high: 20 + index * 10, low: 5 / (index + 1), close: 11 + index,
      }))
      const original = structuredClone(source)
      request.mockResolvedValueOnce(new Response(JSON.stringify({ ...history, bid: source })))
      await act(async () => root.render(<App />))
      await selectTimeframe(0, timeframe)
      await click(button('Start Replay'))
      const series = chartSeries(0)
      const replacements = vi.mocked(series.setData).mock.calls.length
      for (let cursor = 0; cursor < source.length; cursor++) {
        if (cursor > 0) await click(button('Next Candle'))
        // Independent reference: partition just the visible prefix, then reduce each bucket.
        const groups = new Map<number, Candle[]>()
        for (const candle of source.slice(0, cursor + 1)) {
          const bucket = Math.floor(candle.timestamp / TIMEFRAME_MS[timeframe]) * TIMEFRAME_MS[timeframe]
          groups.set(bucket, [...(groups.get(bucket) ?? []), candle])
        }
        const expected = [...groups].map(([timestamp, bucket]) => ({
          time: timestamp / 1000, open: bucket[0].open,
          high: Math.max(...bucket.map((candle) => candle.high)),
          low: Math.min(...bucket.map((candle) => candle.low)), close: bucket.at(-1)!.close,
        }))
        expect(series.data()).toEqual(expected)
        expect(series.data().every((candle) => typeof candle.time === 'number' && candle.time <= source[cursor].timestamp / 1000)).toBe(true)
        if (cursor === 7) {
          expect(host.querySelector('time')!.textContent).toBe('2024-01-09 10:32 UTC')
          if (timeframe === 'H4') expect(series.data()).toEqual([{
            time: base / 1000, open: 10, high: 90, low: 0.625, close: 18,
          }])
          if (timeframe === 'H1') expect(series.data().at(-1)).toEqual({
            time: Date.UTC(2024, 0, 9, 10) / 1000, open: 17, high: 90, low: 0.625, close: 18,
          })
        }
      }
      expect(source).toEqual(original)
      expect(series.setData).toHaveBeenCalledTimes(replacements)
      expect(createChart).toHaveBeenCalledTimes(1)
    })
  }
})

function indicatorLine(chartIndex: number, title: string): ISeriesApi<'Line', UTCTimestamp> | undefined {
  const chart = vi.mocked(createChart).mock.results[chartIndex].value
  const add = vi.mocked(chart.addSeries)
  const index = add.mock.calls.findIndex((call: unknown[]) => (call[1] as { title?: string })?.title === title)
  return index < 0 ? undefined : add.mock.results[index].value
}
async function enableIndicator(chart: number, name: string) {
  await click(host.querySelector<HTMLInputElement>(`input[aria-label="Chart ${chart} ${name}"]`)!)
}
async function parameter(chart: number, name: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="Chart ${chart} ${name}"]`)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  return input
}
async function shortPeriods(chart = 1) {
  for (const name of ['BB #1 Length', 'BB #2 Length', '%K length', '%K smoothing', '%D smoothing', 'Tenkan', 'Kijun', 'Span B', 'Displacement']) await parameter(chart, name, '2')
}

describe('per-chart indicators', () => {
  it('starts disabled, validates edits immediately, and removes only disabled indicator series', async () => {
    await act(async () => root.render(<App />))
    const chart = vi.mocked(createChart).mock.results[0].value
    expect(chart.addSeries).toHaveBeenCalledTimes(1)
    await shortPeriods()
    await enableIndicator(1, 'BB #1')
    expect(chart.addSeries).toHaveBeenCalledTimes(4)
    const middle = indicatorLine(0, 'middle')!
    expect(middle.data()).toHaveLength(4)
    const valid = structuredClone(middle.data())
    for (const value of ['', '0', '-2', '1.5', '10001']) {
      expect((await parameter(1, 'BB #1 Length', value)).getAttribute('aria-invalid')).toBe('true')
      expect(middle.data()).toEqual(valid)
    }
    await parameter(1, 'BB #1 Length', '3')
    expect(middle.data()).toHaveLength(3)
    await enableIndicator(1, 'Stochastic')
    const kIndex = vi.mocked(chart.addSeries).mock.calls.findIndex((call: unknown[]) => (call[1] as { title?: string })?.title === 'k')
    expect(vi.mocked(chart.addSeries).mock.calls[kIndex][2]).toBe(1)
    const k = indicatorLine(0, 'k')!
    expect(k.createPriceLine).toHaveBeenCalledTimes(2)
    expect(vi.mocked(k.createPriceLine).mock.calls.map((call: { price: number }[]) => call[0].price)).toEqual([80, 40])
    await enableIndicator(1, 'BB #1')
    expect(chart.removeSeries).toHaveBeenCalledTimes(3)
    expect(indicatorLine(0, 'k')!.data()).toHaveLength(3)
    await enableIndicator(1, 'Stochastic')
    expect(chart.removeSeries).toHaveBeenCalledTimes(5)
    expect(createChart).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('renders two independent overlays, controls each line, and keeps the second basis hidden', async () => {
    await act(async () => root.render(<App />))
    await shortPeriods()
    await enableIndicator(1, 'BB #1')
    await enableIndicator(1, 'BB #2')
    const chart = vi.mocked(createChart).mock.results[0].value
    const upper = indicatorLine(0, 'upper')!, second = indicatorLine(0, 'upper2')!
    expect(chart.addSeries).toHaveBeenCalledTimes(6)
    expect(indicatorLine(0, 'middle2')).toBeUndefined()
    expect(second.data()).toHaveLength(4)
    const original = structuredClone(upper.data())
    await parameter(1, 'BB #2 Length', '3')
    await parameter(1, 'BB #2 Std. deviation', '0.5')
    expect(second.data()).toHaveLength(3)
    expect(upper.data()).toEqual(original)
    await enableIndicator(1, 'BB #2 Basis')
    expect(indicatorLine(0, 'middle2')!.data()).toHaveLength(3)
    await enableIndicator(1, 'BB #2 Upper')
    expect(chart.removeSeries).toHaveBeenCalledWith(second)
    await enableIndicator(1, 'BB #1')
    expect(chart.removeSeries).toHaveBeenCalledWith(upper)
    expect(chart.removeSeries).not.toHaveBeenCalledWith(indicatorLine(0, 'lower2'))
    expect(createChart).toHaveBeenCalledTimes(1)
  })

  it('preserves independent settings across one-, two-, and three-chart layouts', async () => {
    await act(async () => root.render(<App />))
    await click(host.querySelector<HTMLInputElement>('input[value="3"]')!)
    // Use M1 on each pane to exercise manual settings independently of presets.
    await selectTimeframe(1, 'M1'); await selectTimeframe(2, 'M1')
    await shortPeriods(1); await shortPeriods(2); await shortPeriods(3)
    await parameter(1, 'BB #1 Length', '3')
    await enableIndicator(1, 'BB #1')
    await enableIndicator(2, 'Ichimoku')
    await enableIndicator(2, 'BB #2')
    await parameter(2, 'BB #2 Length', '4')
    await enableIndicator(3, 'Stochastic')
    expect(indicatorLine(0, 'middle')!.data()).toHaveLength(3)
    expect(indicatorLine(0, 'spanA')).toBeUndefined()
    expect(indicatorLine(1, 'spanA')!.attachPrimitive).toHaveBeenCalledTimes(1)
    expect(indicatorLine(2, 'k')).toBeDefined()
    await click(host.querySelector<HTMLInputElement>('input[value="1"]')!)
    const second = vi.mocked(createChart).mock.results[1].value
    expect(second.remove).toHaveBeenCalledTimes(1)
    expect(indicatorLine(1, 'spanA')!.detachPrimitive).toHaveBeenCalledTimes(1)
    await click(host.querySelector<HTMLInputElement>('input[value="3"]')!)
    expect(host.querySelector<HTMLInputElement>('[aria-label="Chart 1 BB #1 Length"]')!.value).toBe('3')
    expect(host.querySelector<HTMLInputElement>('[aria-label="Chart 2 Ichimoku"]')!.checked).toBe(true)
    expect(host.querySelector<HTMLInputElement>('[aria-label="Chart 3 Stochastic"]')!.checked).toBe(true)
    expect(host.querySelector<HTMLInputElement>('[aria-label="Chart 2 BB #2 Length"]')!.value).toBe('4')
    expect(host.querySelector<HTMLInputElement>('[aria-label="Chart 1 BB #2"]')!.checked).toBe(false)
    expect(indicatorLine(3, 'upper2')).toBeDefined()
    expect(indicatorLine(3, 'spanA')!.attachPrimitive).toHaveBeenCalledTimes(1)
    expect(indicatorLine(4, 'k')).toBeDefined()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('resets active indicators on restart and date reload, reusing the price chart', async () => {
    await act(async () => root.render(<App />))
    await shortPeriods()
    for (const name of ['BB #1', 'BB #2', 'Stochastic', 'Ichimoku']) await enableIndicator(1, name)
    await click(button('Start Replay'))
    expect(indicatorLine(0, 'middle')!.data()).toHaveLength(0)
    expect(indicatorLine(0, 'k')!.data()).toHaveLength(0)
    const span = indicatorLine(0, 'spanA')!
    expect(span.data().every((p) => !('value' in p))).toBe(true)
    await click(button('Next Candle')); await click(button('Next Candle')); await click(button('Next Candle'))
    expect(indicatorLine(0, 'middle')!.data()).toHaveLength(3)
    expect(indicatorLine(0, 'k')!.data()).toHaveLength(2)
    expect(indicatorLine(0, 'chikou')!.data()).toHaveLength(2)
    await click(button('Restart'))
    expect(indicatorLine(0, 'middle')!.data()).toEqual([])
    expect(indicatorLine(0, 'chikou')!.data()).toEqual([])
    expect(span.data().every((p) => !('value' in p))).toBe(true)
    await changeDates()
    expect(replayStatus()).toBe('Ready')
    expect(indicatorLine(0, 'middle')!.data()).toHaveLength(4)
    expect(indicatorLine(0, 'middle')!.data()[0].time).toBe(Date.UTC(2024, 0, 10, 1) / 1000)
    await click(button('Start Replay'))
    expect(indicatorLine(0, 'middle')!.data()).toEqual([])
    expect(createChart).toHaveBeenCalledTimes(1)
  })

  it('cleans panes, cloud primitives, series and synchronization subscriptions', async () => {
    await act(async () => root.render(<StrictMode><App /></StrictMode>))
    await shortPeriods()
    for (const name of ['BB #1', 'BB #2', 'Stochastic', 'Ichimoku']) await enableIndicator(1, name)
    const chart = vi.mocked(createChart).mock.results.at(-1)!.value
    const add = vi.mocked(chart.addSeries)
    const span = add.mock.results[add.mock.calls.findIndex((call: unknown[]) => (call[1] as { title?: string })?.title === 'spanA')].value
    await enableIndicator(1, 'Ichimoku')
    expect(span.detachPrimitive).toHaveBeenCalledTimes(1)
    await enableIndicator(1, 'Ichimoku')
    await act(async () => root.unmount()); rootMounted = false
    expect(chart.removeSeries).toHaveBeenCalledTimes(17)
    expect(chart.remove).toHaveBeenCalledTimes(1)
    for (const result of add.mock.results) if (vi.mocked(result.value.attachPrimitive).mock.calls.length) expect(result.value.detachPrimitive).toHaveBeenCalledTimes(1)
    expect(chart.unsubscribeCrosshairMove).toHaveBeenCalledTimes(vi.mocked(chart.subscribeCrosshairMove).mock.calls.length)
  })

  for (const timeframe of TIMEFRAMES) it(`keeps active ${timeframe} indicators behind the replay clock, including partial candle changes`, async () => {
    const step = TIMEFRAME_MS[timeframe]
    const bid: Candle[] = Array.from({ length: 6 }, (_, index) => ({ timestamp: Date.UTC(2024, 0, 9) + index * step, open: 10 + index, high: 12 + index, low: 8 + index, close: 10 + index }))
    bid.splice(5, 0, { timestamp: bid[4].timestamp + 60_000, open: 15, high: 24, low: 4, close: 20 })
    // M1's extra bar shares a timestamp with the following bar: omit it there.
    if (timeframe === 'M1') bid.splice(5, 1)
    bid.at(-1)!.high = 1e6; bid.at(-1)!.low = 0.001; bid.at(-1)!.close = 99999
    request.mockResolvedValueOnce(new Response(JSON.stringify({ ...history, bid })))
    await act(async () => root.render(<App />))
    await selectTimeframe(0, timeframe)
    await shortPeriods()
    for (const name of ['BB #1', 'BB #2', 'Stochastic', 'Ichimoku']) {
      const input = host.querySelector<HTMLInputElement>(`input[aria-label="Chart 1 ${name}"]`)!
      if (!input.checked) await click(input)
    }
    await click(button('Start Replay'))
    const { calculateIndicators, defaultIndicatorSettings } = await import('./indicators')
    const { toBidChartCandles } = await import('./history')
    const s = defaultIndicatorSettings()
    s.bollinger = { ...s.bollinger, enabled: true, length: 2, stdDev: 2 }
    s.bollinger2 = { ...s.bollinger2, enabled: true, length: 2 }
    s.stochastic = { enabled: true, length: 2, smoothK: 2, smoothD: 2 }
    s.ichimoku = { enabled: true, tenkan: 2, kijun: 2, spanB: 2, displacement: 2 }
    const middle = indicatorLine(0, 'middle')!, k = indicatorLine(0, 'k')!
    const sets = vi.mocked(middle.setData).mock.calls.length
    for (let count = 1; count < bid.length; count++) {
      if (count > 1) await click(button('Next Candle'))
      const expected = calculateIndicators(toBidChartCandles({ bid: bid.slice(0, count) }, timeframe), s, timeframe)
      for (const title of ['upper', 'middle', 'lower', 'upper2', 'lower2', 'k', 'd', 'tenkan', 'kijun', 'spanB', 'chikou'] as const) expect(indicatorLine(0, title)!.data()).toEqual(expected[title])
      expect(indicatorLine(0, 'spanA')!.data().filter((p) => 'value' in p)).toEqual(expected.spanA)
      expect(expected.middle.every((p) => p.value < 100)).toBe(true)
    }
    expect(vi.mocked(middle.setData).mock.calls.length).toBeLessThanOrEqual(sets + 1)
    expect(k.update).toHaveBeenCalled()
    expect(createChart).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledTimes(1)
  })
})

function checked(chart: number, indicator: string) {
  return host.querySelector<HTMLInputElement>(`[aria-label="Chart ${chart} ${indicator}"]`)!.checked
}
function records(name: string) { return host.querySelector<HTMLElement>(`[aria-label="${name}"]`)! }
function recordCount(name: string) { return records(name).querySelectorAll('li').length }
async function setInput(label: string, value: string) {
  const input = [...host.querySelectorAll<HTMLInputElement>('input')].find((input) => input.getAttribute('aria-label') === label || input.closest('label')?.textContent === label)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function volume(value: string) {
  const input = host.querySelector<HTMLInputElement>('.trading-controls input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  return input
}
function tradingHistory() {
  return { ...history,
    bid: history.bid.map((bar, index) => ({ ...bar, open: 1.1 + index * 0.001, close: 1.1005 + index * 0.001 })),
    ask: history.bid.map((bar, index) => ({ ...bar, open: 1.1002 + index * 0.001, close: 1.1007 + index * 0.001 })),
  }
}

describe('timeframe indicator presets', () => {
  it.each(TIMEFRAMES)('initializes %s with its default parameters and line visibility', async (timeframe) => {
    await act(async () => root.render(<App />))
    await selectTimeframe(0, timeframe)
    const bands = timeframe === 'M5' || timeframe === 'M15'
    expect(checked(1, 'BB #1')).toBe(bands)
    expect(checked(1, 'BB #2')).toBe(bands)
    expect(checked(1, 'Stochastic')).toBe(bands)
    expect(checked(1, 'Ichimoku')).toBe(timeframe === 'H1' || timeframe === 'H4')
    expect(checked(1, 'BB #1 Basis')).toBe(true)
    expect(checked(1, 'BB #2 Basis')).toBe(false)
    const values: Record<string, string> = {
      'BB #1 Length': '20', 'BB #1 Std. deviation': '2', 'BB #2 Length': '20', 'BB #2 Std. deviation': '1',
      '%K length': '30', '%K smoothing': '10', '%D smoothing': '10', Tenkan: '9', Kijun: '26', 'Span B': '52', Displacement: '26',
    }
    for (const [name, value] of Object.entries(values)) {
      expect(host.querySelector<HTMLInputElement>(`[aria-label="Chart 1 ${name}"]`)!.value).toBe(value)
    }
    expect(createChart).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('restores each chart/timeframe override across layout changes, replay, and date loads', async () => {
    await act(async () => root.render(<App />))
    await selectTimeframe(0, 'M5')
    await parameter(1, 'BB #1 Length', '7')
    await enableIndicator(1, 'BB #2') // Explicitly disable a preset indicator.
    await enableIndicator(1, 'Ichimoku') // Other indicators remain available.
    await selectTimeframe(0, 'H1')
    await parameter(1, 'Tenkan', '4')
    await click(host.querySelector<HTMLInputElement>('input[value="3"]')!)
    expect(checked(2, 'BB #1')).toBe(true)
    expect(checked(2, 'BB #2')).toBe(true)
    expect(checked(2, 'Ichimoku')).toBe(false)
    expect(checked(3, 'Ichimoku')).toBe(true)
    await selectTimeframe(1, 'M5')
    expect(host.querySelector<HTMLInputElement>('[aria-label="Chart 2 BB #1 Length"]')!.value).toBe('20')
    await click(button('Start Replay'))
    await click(button('Next Candle'))
    await selectTimeframe(0, 'M5')
    expect(host.querySelector<HTMLInputElement>('[aria-label="Chart 1 BB #1 Length"]')!.value).toBe('7')
    expect(checked(1, 'BB #2')).toBe(false)
    expect(checked(1, 'Ichimoku')).toBe(true)
    expect(progress()).toBe('2 / 5 candles')
    expect(replayStatus()).toBe('Paused')
    await click(host.querySelector<HTMLInputElement>('input[value="1"]')!)
    await click(host.querySelector<HTMLInputElement>('input[value="3"]')!)
    await selectTimeframe(0, 'H1')
    expect(host.querySelector<HTMLInputElement>('[aria-label="Chart 1 Tenkan"]')!.value).toBe('4')
    expect(request).toHaveBeenCalledTimes(1)
    await changeDates()
    await selectTimeframe(0, 'M5')
    expect(host.querySelector<HTMLInputElement>('[aria-label="Chart 1 BB #1 Length"]')!.value).toBe('7')
    expect(checked(1, 'BB #2')).toBe(false)
  })
})

describe('simulated trading with the shared replay clock', () => {
  it('validates lots and disables trading in full-history mode and while playing', async () => {
    request.mockResolvedValueOnce(new Response(JSON.stringify(tradingHistory())))
    await act(async () => root.render(<App />))
    expect(button('Buy').disabled).toBe(true)
    expect(button('Sell').disabled).toBe(true)
    await click(button('Start Replay'))
    expect(host.querySelector<HTMLInputElement>('.trading-controls input')!.value).toBe('0.01')
    for (const value of ['', '0', '-1']) {
      expect((await volume(value)).getAttribute('aria-invalid')).toBe('true')
      expect(button('Buy').disabled).toBe(true)
      await click(button('Buy'))
      expect(recordCount('Pending orders')).toBe(0)
    }
    await setInput('SL price', '0.5')
    await volume('0.025')
    expect(button('Buy').disabled).toBe(false)
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 0))
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await click(button('Play'))
    expect(button('Buy').disabled).toBe(true)
    expect(button('Sell').disabled).toBe(true)
    await click(button('Pause'))
    expect(button('Buy').disabled).toBe(false)
  })

  it('fills two independent positions at the first eligible bar during batched StrictMode playback', async () => {
    request.mockImplementation(async () => new Response(JSON.stringify(tradingHistory())))
    await act(async () => root.render(<StrictMode><App /></StrictMode>))
    await click(button('Start Replay'))
    await click(button('Buy'))
    await volume('0.03')
    await click(button('Sell'))
    const ids = [...records('Pending orders').querySelectorAll('li')].map((item) => item.dataset.orderId)
    expect(new Set(ids).size).toBe(2)
    expect(recordCount('Pending orders')).toBe(2)
    expect(recordCount('Open positions')).toBe(0)
    expect(button('Buy').disabled).toBe(true)
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 0))
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await click(button('Play'))
    await act(async () => vi.advanceTimersByTime(500))
    await click(button('Pause'))
    expect(progress()).toBe('3 / 5 candles')
    expect(recordCount('Pending orders')).toBe(0)
    const positions = [...records('Open positions').querySelectorAll('li')]
    expect(positions.map((item) => item.dataset.positionId)).toEqual(ids)
    expect(positions[0].textContent).toContain('Buy · 0.01 lots')
    expect(positions[0].textContent).toContain('Entry 2024-01-09 01:00 UTC @ 1.10120')
    expect(positions[0].textContent).toContain('Current 1.10250 · Unrealized 13.0 pips · $1.30 gross')
    expect(positions[1].textContent).toContain('Sell · 0.03 lots')
    expect(positions[1].textContent).toContain('Entry 2024-01-09 01:00 UTC @ 1.10100')
    expect(positions[1].textContent).toContain('Current 1.10270 · Unrealized -17.0 pips · $-5.10 gross')
    const closeButtons = [...records('Open positions').querySelectorAll<HTMLButtonElement>('button[aria-label^="Close position"]')]
    await click(button('Play'))
    expect(closeButtons.every((button) => button.disabled)).toBe(true)
    await click(button('Pause'))
    await click(closeButtons[0]); await click(closeButtons[1])
    await click(closeButtons[0]) // Disabled duplicate request.
    expect(records('Open positions').textContent?.match(/Pending close/g)).toHaveLength(2)
    expect(recordCount('Closed trades')).toBe(0)
    await click(button('Play'))
    await act(async () => vi.advanceTimersByTime(500))
    expect(replayStatus()).toBe('Complete')
    expect(recordCount('Open positions')).toBe(0)
    const closed = [...records('Closed trades').querySelectorAll('li')]
    expect(closed.map((item) => item.dataset.tradeId)).toEqual(ids)
    expect(closed[0].textContent).toContain('Exit 2024-01-09 03:00 UTC @ 1.10300')
    expect(closed[0].textContent).toContain('Realized 18.0 pips · $1.80 gross')
    expect(closed[1].textContent).toContain('Exit 2024-01-09 03:00 UTC @ 1.10320')
    expect(closed[1].textContent).toContain('Realized -22.0 pips · $-6.60 gross')
    expect(button('Buy').disabled).toBe(true)
    await click(button('Restart'))
    for (const name of ['Pending orders', 'Open positions', 'Closed trades']) expect(recordCount(name)).toBe(0)
  })

  it('preserves pending entries, positions and closes through chart navigation and resets on restart/data reload', async () => {
    request.mockImplementation(async () => new Response(JSON.stringify(tradingHistory())))
    await act(async () => root.render(<App />))
    await click(button('Start Replay'))
    await click(button('Buy'))
    expect(button('Restart').disabled).toBe(false)
    await click(button('Restart')) // Restart also clears orders requested at the first candle.
    expect(recordCount('Pending orders')).toBe(0)
    await click(button('Buy'))
    await selectTimeframe(0, 'H4')
    await click(host.querySelector<HTMLInputElement>('input[value="3"]')!)
    expect(recordCount('Pending orders')).toBe(1)
    await click(button('Next Candle'))
    const position = records('Open positions').querySelector('li')!
    const id = position.dataset.positionId
    const chart = vi.mocked(createChart).mock.results[0].value
    await act(async () => {
      chart.timeScale().setVisibleLogicalRange({ from: 0, to: 1 })
      host.querySelector('.chart-pane')!.dispatchEvent(new Event('wheel', { bubbles: true }))
    })
    await selectTimeframe(0, 'M15')
    await enableIndicator(1, 'Ichimoku')
    await click(host.querySelector<HTMLInputElement>('input[value="1"]')!)
    expect(records('Open positions').querySelector('li')!.dataset.positionId).toBe(id)
    expect(progress()).toBe('2 / 5 candles')
    await click(records('Open positions').querySelector('button')!)
    await selectTimeframe(0, 'M1')
    expect(records('Open positions').textContent).toContain('Pending close')
    await click(button('Next Candle'))
    await click(button('Buy')) // Reset must clear both a closed record and a pending order.
    expect(recordCount('Closed trades')).toBe(1)
    await click(button('Load Data'))
    expect(replayStatus()).toBe('Ready')
    for (const name of ['Pending orders', 'Open positions', 'Closed trades']) expect(recordCount(name)).toBe(0)
    await click(button('Start Replay')); await click(button('Sell')); await click(button('Next Candle'))
    expect(recordCount('Open positions')).toBe(1)
    await click(button('Load Data'))
    expect(recordCount('Open positions')).toBe(0)
  })

  it('cancels entries before execution and leaves missing-quote orders unfilled at the final candle', async () => {
    const data = tradingHistory()
    data.ask = data.ask.slice(0, 2)
    request.mockResolvedValueOnce(new Response(JSON.stringify(data)))
    await act(async () => root.render(<App />))
    await click(button('Start Replay')); await click(button('Buy'))
    await click(records('Pending orders').querySelector('button')!)
    await click(button('Next Candle'))
    expect(recordCount('Open positions')).toBe(0)
    await click(button('Buy'))
    await click(button('Next Candle')); await click(button('Next Candle')); await click(button('Next Candle'))
    expect(replayStatus()).toBe('Complete')
    expect(recordCount('Pending orders')).toBe(1)
    expect(recordCount('Open positions')).toBe(0)
    expect(button('Buy').disabled).toBe(true)
    expect(host.textContent).toContain('unfilled orders stay pending')
    await click(records('Pending orders').querySelector('button')!)
    expect(recordCount('Pending orders')).toBe(0)
  })

  it('leaves positions open with unavailable valuation at an unmatched final quote, without forcing an exit', async () => {
    const data = tradingHistory()
    data.ask = data.ask.slice(0, 2)
    request.mockResolvedValueOnce(new Response(JSON.stringify(data)))
    await act(async () => root.render(<App />))
    await click(button('Start Replay')); await click(button('Buy')); await click(button('Next Candle'))
    await click(records('Open positions').querySelector('button')!)
    await click(button('Next Candle')); await click(button('Next Candle')); await click(button('Next Candle'))
    expect(recordCount('Open positions')).toBe(1)
    expect(recordCount('Closed trades')).toBe(0)
    expect(records('Open positions').textContent).toContain('PnL unavailable')
    expect(records('Open positions').textContent).toContain('Open at end of available history; close unfilled')
    expect(records('Open positions').querySelector('button')!.disabled).toBe(true)
  })

  it('does not mark or fill from unrevealed future candles or unmatched ask-only timestamps', async () => {
    const data = tradingHistory()
    // Ask only between the first two bid observations, followed by unmatched bid bars.
    data.ask = [data.ask[0], { ...data.ask[1], timestamp: data.bid[0].timestamp + 60_000 }, data.ask[3], data.ask[4]]
    data.bid[4].close = 99999; data.bid[4].high = 100000
    data.ask[3].close = 99999; data.ask[3].high = 100000
    request.mockResolvedValueOnce(new Response(JSON.stringify(data)))
    await act(async () => root.render(<App />))
    await click(button('Start Replay')); await click(button('Buy'))
    await click(button('Next Candle')); await click(button('Next Candle'))
    expect(recordCount('Pending orders')).toBe(1)
    expect(recordCount('Open positions')).toBe(0)
    expect(records('Pending orders').textContent).not.toContain('99999')
    await click(button('Next Candle'))
    expect(recordCount('Pending orders')).toBe(0)
    expect(records('Open positions').textContent).toContain('Entry 2024-01-09 03:00 UTC @ 1.10320')
    expect(records('Open positions').textContent).toContain('Current 1.10350')
    // The future bid close is still unavailable at this replay clock.
    expect(records('Open positions').textContent).not.toContain('99999')
  })
})

describe('stop-loss controls and chart lifecycle', () => {
  function stopHistory() {
    const bid = [
      [1.1, 1.0998, 1.1003, 1.1001],
      [1.1001, 1.0998, 1.1004, 1.1002],
      [1.1003, 1.1001, 1.1021, 1.102],
      [1.102, 1.1008, 1.1022, 1.1015],
      [1.1015, 1.0988, 1.1017, 1.099],
      [1.099, 1.0988, 1.0993, 1.0992],
    ].map(([open, low, high, close], index) => ({ timestamp: Date.UTC(2024, 0, 9) + index * 60_000, open, low, high, close }))
    return { ...history, bid, ask: bid.map((candle) => ({ ...candle, open: candle.open + 0.0002,
      low: candle.low + 0.0002, high: candle.high + 0.0002, close: candle.close + 0.0002 })) }
  }
  beforeEach(() => { defaultStops = false; request.mockImplementation(async () => new Response(JSON.stringify(stopHistory()))) })
  const priceSeries = (chartIndex = 0) => vi.mocked(createChart).mock.results[chartIndex].value.addSeries.mock.results[0].value

  it('requires SL, preserves independent pending prices, and surfaces actual-fill rejections', async () => {
    await act(async () => root.render(<App />))
    await click(button('Start Replay'))
    expect(button('Buy').disabled).toBe(true)
    await setInput('SL price', '1.101')
    await click(button('Buy'))
    await setInput('SL price', '1.103')
    await volume('0.03'); await click(button('Sell'))
    expect(records('Pending orders').textContent).toContain('SL 1.10100')
    expect(records('Pending orders').textContent).toContain('SL 1.10300')
    await click(button('Next Candle'))
    expect(recordCount('Open positions')).toBe(1)
    expect(records('Pending orders').textContent).toContain('Rejected Buy')
    expect(records('Pending orders').textContent).toContain('actual entry 1.10030')
    expect(button('Buy').disabled).toBe(false)
  })

  it('keeps independent SL lines on every chart, updates profit SL, and cleans up after stops and reset', async () => {
    await act(async () => root.render(<App />))
    await click(button('Start Replay'))
    await setInput('SL price', '1.099'); await click(button('Buy'))
    await volume('0.03'); await setInput('SL price', '1.098'); await click(button('Buy'))
    await click(button('Next Candle'))
    const ids = [...records('Open positions').querySelectorAll('li')].map((item) => item.dataset.positionId!)
    expect(priceSeries().createPriceLine.mock.calls.map(([options]: [{price: number}]) => options.price)).toEqual([1.099, 1.098])
    await click(host.querySelector<HTMLInputElement>('input[value="3"]')!)
    for (const index of [1, 2]) expect(priceSeries(index).createPriceLine.mock.calls.slice(0, 2).map(([options]: [{price: number}]) => options.price)).toEqual([1.099, 1.098])
    await click(button('Next Candle'))
    await setInput(`Replacement SL ${ids[0]}`, '1.1003') // Break-even.
    await click(button('Update SL'))
    expect(records('Open positions').textContent).toContain('1.09900 → 1.10030')
    await setInput(`Replacement SL ${ids[0]}`, '1.101')
    await click([...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.getAttribute('aria-label') === `Update SL ${ids[0]}`)!)
    const creationCount = vi.mocked(createChart).mock.calls.length
    for (const index of [0, 1, 2]) {
      const line = priceSeries(index).createPriceLine.mock.results[0].value
      expect(line.applyOptions).toHaveBeenLastCalledWith(expect.objectContaining({ price: 1.101 }))
    }
    await selectTimeframe(0, 'H1')
    expect(records('Open positions').textContent).toContain('SL 1.10100')
    await click(button('Next Candle'))
    expect(recordCount('Open positions')).toBe(1)
    expect(records('Closed trades').textContent).toContain('Realized 7.0 pips · $0.70 gross')
    expect(records('Closed trades').textContent).toContain('Stop loss · level fill')
    expect(records('Closed trades').textContent).toContain('Triggering M1 candle timestamp')
    expect(createChart).toHaveBeenCalledTimes(creationCount)
    for (const index of [0, 1, 2]) expect(priceSeries(index).removePriceLine).toHaveBeenCalledTimes(1)
    await click(button('Restart'))
    for (const index of [0, 1, 2]) expect(priceSeries(index).removePriceLine).toHaveBeenCalledTimes(2)
    expect(recordCount('Open positions')).toBe(0)
    expect(recordCount('Closed trades')).toBe(0)
  })

  it('stops same-candle shorts on ask spikes during batched StrictMode playback without duplicates or pausing', async () => {
    const data = stopHistory()
    data.ask[1].high = 1.15
    request.mockImplementation(async () => new Response(JSON.stringify(data)))
    await act(async () => root.render(<StrictMode><App /></StrictMode>))
    await click(button('Start Replay'))
    await setInput('SL price', '1.103'); await click(button('Sell'))
    await setInput('SL price', '1.098'); await click(button('Buy'))
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 0))
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await click(button('Play'))
    await act(async () => vi.advanceTimersByTime(750))
    expect(replayStatus()).toBe('Playing')
    expect(recordCount('Open positions')).toBe(1)
    expect(recordCount('Closed trades')).toBe(1)
    const trade = records('Closed trades').textContent!
    expect(trade).toContain('Entry 2024-01-09 00:01 UTC @ 1.10010')
    expect(trade).toContain('Exit 2024-01-09 00:01 UTC @ 1.10300')
    expect(trade).toContain('Realized -29.0 pips · $-2.90 gross')
    expect([...records('Open positions').querySelectorAll('button')].every((item) => item.disabled)).toBe(true)
    await act(async () => vi.advanceTimersByTime(1000))
    expect(replayStatus()).toBe('Complete')
    expect(recordCount('Closed trades')).toBe(1)
    expect(records('Open positions').textContent).toContain('Open at end of available history')
    expect(host.querySelector<HTMLInputElement>('input[aria-label^="Replacement SL"]')!.disabled).toBe(true)
    const activeCharts = vi.mocked(createChart).mock.results.filter((result) => !result.value.remove.mock.calls.length)
    expect(activeCharts).toHaveLength(1)
    await click(button('Load Data'))
    expect(recordCount('Closed trades')).toBe(0)
    expect(recordCount('Open positions')).toBe(0)
    expect(activeCharts[0].value.addSeries.mock.results[0].value.removePriceLine).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTime(1000))
    expect(replayStatus()).toBe('Ready')
  })

  it('preserves coincident stop IDs when panes are removed and recreated', async () => {
    await act(async () => root.render(<App />))
    await click(button('Start Replay')); await setInput('SL price', '1.099')
    await click(button('Buy')); await click(button('Buy')); await click(button('Next Candle'))
    const ids = [...records('Open positions').querySelectorAll('li')].map((item) => item.dataset.positionId!)
    expect(priceSeries().createPriceLine.mock.calls.map(([options]: [{title: string}]) => options.title)).toEqual([
      `SL ${ids.join(' / ')} · 1.09900`, `SL ${ids.join(' / ')} · 1.09900`,
    ])
    await click(host.querySelector<HTMLInputElement>('input[value="3"]')!)
    await click(host.querySelector<HTMLInputElement>('input[value="1"]')!)
    expect(vi.mocked(createChart).mock.results[1].value.remove).toHaveBeenCalledTimes(1)
    expect(vi.mocked(createChart).mock.results[2].value.remove).toHaveBeenCalledTimes(1)
    await click(host.querySelector<HTMLInputElement>('input[value="3"]')!)
    for (const index of [3, 4]) expect(priceSeries(index).createPriceLine.mock.calls.slice(0, 2).map(([options]: [{price: number}]) => options.price)).toEqual([1.099, 1.099])
    expect(recordCount('Open positions')).toBe(2)
  })

  it('shows persistent ask coverage warnings and blocks changes until a current quote is available', async () => {
    const data = stopHistory(); data.ask = data.ask.filter((_, index) => index !== 2)
    request.mockImplementation(async () => new Response(JSON.stringify(data)))
    await act(async () => root.render(<App />))
    await click(button('Start Replay')); await setInput('SL price', '1.105'); await click(button('Sell'))
    await click(button('Next Candle')); await click(button('Next Candle'))
    expect(records('Open positions').textContent).toContain('SL coverage uncertain: ask quote unavailable')
    expect(records('Open positions').textContent).toContain('current ask closing quote is unavailable')
    expect(button('Update SL').disabled).toBe(true)
    await click(button('Next Candle'))
    expect(records('Open positions').textContent).toContain('SL coverage uncertain: ask quote unavailable')
    expect(records('Open positions').textContent).not.toContain('current ask closing quote is unavailable')
  })
})
