// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { IChartApi, UTCTimestamp } from 'lightweight-charts'
import { bindRegressionAnchor } from './useRegressionAnchor'

const base = Date.UTC(2024, 0, 9)
let element: HTMLDivElement, dispose: () => void, enabled = false, count = 20
const onAnchor = vi.fn(), pan = vi.fn(), trade = vi.fn(), stop = vi.fn()
const source = Array.from({ length: 20 }, (_, i) => ({ timestamp: base + i * 60_000, open: 1, high: 1, low: 1, close: 1 }))
const candles = Array.from({ length: 4 }, (_, i) => ({ time: (base / 1000 + i * 300) as UTCTimestamp }))
const chart = { timeScale: () => ({ width: () => 400, coordinateToTime: (x: number) => base / 1000 + Math.floor(x / 50) * 300 }),
  panes: () => [{ getHeight: () => 300 }] } as unknown as IChartApi
function pointer(type: string, x = 100, y = 100, ctrlKey = true, target: EventTarget = element) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ctrlKey })
  Object.defineProperty(event, 'pointerId', { value: 1 }); target.dispatchEvent(event)
  return event
}
beforeEach(() => {
  enabled = false; count = 20; vi.clearAllMocks()
  element = document.createElement('div'); document.body.append(element)
  dispose = bindRegressionAnchor({ element, chart, enabled: () => enabled, candles: () => candles, source: () => source, count: () => count, onAnchor })
  element.addEventListener('pointerdown', pan)
  element.addEventListener('mousedown', stop)
  element.addEventListener('click', trade)
})
afterEach(() => { dispose(); element.remove() })
it('defaults off, anchors/replaces on M5 opening timestamps, then disables repositioning', () => {
  expect(pointer('pointerdown').defaultPrevented).toBe(false)
  expect(onAnchor).not.toHaveBeenCalled()
  enabled = true
  expect(pointer('pointerdown').defaultPrevented).toBe(true)
  expect(onAnchor).toHaveBeenLastCalledWith(base + 10 * 60000)
  pointer('pointerup')
  pointer('pointerdown', 50)
  expect(onAnchor).toHaveBeenLastCalledWith(base + 5 * 60000)
  pointer('pointerup', 50)
  enabled = false; onAnchor.mockClear()
  expect(pointer('pointerdown').defaultPrevented).toBe(false)
  expect(onAnchor).not.toHaveBeenCalled()
})
it('consumes the full gesture without trade placement, stop dragging or chart panning, and cleans up', () => {
  enabled = true
  pointer('pointerdown'); pointer('pointermove', 110); pointer('pointerup', 110)
  for (const type of ['mousedown', 'mouseup', 'click', 'dblclick']) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true }); element.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  }
  expect(pan).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled(); expect(trade).not.toHaveBeenCalled()
  pointer('pointerdown', 100, 100, false)
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  expect(pan).toHaveBeenCalledOnce(); expect(trade).toHaveBeenCalledOnce()
  dispose(); onAnchor.mockClear()
  pointer('pointerdown')
  expect(onAnchor).not.toHaveBeenCalled()
})
it('finds the first available revealed M1 in a partial bucket and ignores unrevealed observations', () => {
  enabled = true; dispose()
  dispose = bindRegressionAnchor({ element, chart, enabled: () => enabled, candles: () => candles,
    source: () => source.filter((_, i) => i !== 10 && i !== 11), count: () => count, onAnchor })
  count = 18
  pointer('pointerdown')
  expect(onAnchor).toHaveBeenLastCalledWith(base + 12 * 60000)
  count = 10; onAnchor.mockClear()
  pointer('pointerdown')
  expect(onAnchor).not.toHaveBeenCalled()
})
it('anchors the exact clicked observation on M1', () => {
  enabled = true; dispose()
  const m1Chart = { timeScale: () => ({ width: () => 400, coordinateToTime: () => source[7].timestamp / 1000 }), panes: () => [{ getHeight: () => 300 }] } as unknown as IChartApi
  dispose = bindRegressionAnchor({ element, chart: m1Chart, enabled: () => enabled, candles: () => source.map(bar => ({ time: bar.timestamp / 1000 as UTCTimestamp })),
    source: () => source, count: () => count, onAnchor })
  pointer('pointerdown')
  expect(onAnchor).toHaveBeenLastCalledWith(source[7].timestamp)
})
it.each([[450, 100], [100, 350], [300, 100]])('ignores axes, oscillator panes and projected whitespace at (%s, %s)', (x, y) => {
  enabled = true
  pointer('pointerdown', x, y)
  expect(onAnchor).not.toHaveBeenCalled()
})
it('does not swallow unrelated controls after anchoring', () => {
  enabled = true; pointer('pointerdown'); pointer('pointerup')
  const button = document.createElement('button'), click = vi.fn(); document.body.append(button); button.addEventListener('click', click)
  button.click()
  expect(click).toHaveBeenCalledOnce()
  button.remove()
})
it('owns Ctrl clicks on draft annotations over the candle area before draft/stop handlers', () => {
  enabled = true; dispose()
  const plot = document.createElement('div'), annotation = document.createElement('span')
  plot.className = 'chart-plot'; document.body.append(plot); plot.append(element, annotation)
  dispose = bindRegressionAnchor({ element, chart, enabled: () => enabled, candles: () => candles, source: () => source, count: () => count, onAnchor })
  const drag = vi.fn(); annotation.addEventListener('pointerdown', drag)
  expect(pointer('pointerdown', 100, 100, true, annotation).defaultPrevented).toBe(true)
  expect(onAnchor).toHaveBeenCalledOnce(); expect(drag).not.toHaveBeenCalled()
  document.body.append(element); plot.remove()
})
it('prioritizes channel deletion over anchor replacement and consumes the entire gesture', () => {
  enabled = true; dispose()
  const hitChannel = vi.fn(() => true)
  dispose = bindRegressionAnchor({ element, chart, enabled: () => enabled, candles: () => candles, source: () => source, count: () => count, onAnchor, hitChannel })
  pointer('pointerdown'); pointer('pointermove'); pointer('pointerup')
  for (const type of ['mousedown', 'mouseup', 'click', 'dblclick']) element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
  expect(hitChannel).toHaveBeenCalledWith(100, 100)
  expect(onAnchor).toHaveBeenCalledExactlyOnceWith(null)
  expect(pan).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled(); expect(trade).not.toHaveBeenCalled()
  // No toggle change is needed to place a new anchor after deleting.
  hitChannel.mockReturnValue(false)
  pointer('pointerdown', 50)
  expect(onAnchor).toHaveBeenLastCalledWith(base + 5 * 60000)
  enabled = false; onAnchor.mockClear(); hitChannel.mockClear()
  pointer('pointerdown')
  expect(onAnchor).not.toHaveBeenCalled(); expect(hitChannel).not.toHaveBeenCalled()
})
it('deletes a channel over projected whitespace before resolving a candle', () => {
  enabled = true; dispose()
  dispose = bindRegressionAnchor({ element, chart, enabled: () => enabled, candles: () => candles, source: () => source, count: () => count, onAnchor, hitChannel: () => true })
  pointer('pointerdown', 300)
  expect(onAnchor).toHaveBeenCalledExactlyOnceWith(null)
})
