// @vitest-environment jsdom
import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createChart, type CandlestickData, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts'
import { App } from './App'
import { TIMEFRAMES, TIMEFRAME_MS, type Candle } from './history'

vi.mock('lightweight-charts', () => ({
  CandlestickSeries: {}, ColorType: { Solid: 'solid' },
  createChart: vi.fn(() => {
    let range = { from: 0, to: 2 }
    const scale = { getVisibleLogicalRange: () => range, fitContent: vi.fn(),
      setVisibleLogicalRange: (next: typeof range) => { range = next },
      subscribeVisibleLogicalRangeChange: vi.fn(), unsubscribeVisibleLogicalRangeChange: vi.fn() }
    let values: CandlestickData<UTCTimestamp>[] = []
    const series = {
      setData: vi.fn((next: typeof values) => { values = next.map((candle) => ({ ...candle })) }),
      update: vi.fn((candle: typeof values[number]) => {
        const last = values.at(-1)
        if (last && candle.time < last.time) throw new Error('Out-of-order chart update')
        if (last?.time === candle.time) values[values.length - 1] = { ...candle }
        else values.push({ ...candle })
      }),
      data: () => values,
    }
    return {
      addSeries: vi.fn(() => series), remove: vi.fn(),
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
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function click(input: HTMLInputElement | HTMLButtonElement) {
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
