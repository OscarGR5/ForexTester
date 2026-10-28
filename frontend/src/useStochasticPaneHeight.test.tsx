// @vitest-environment jsdom
import { act, StrictMode, useLayoutEffect, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { IChartApi } from 'lightweight-charts'
import { useStochasticPaneHeight } from './useStochasticPaneHeight'
import { readUi, uiKey, validPaneShare, writeUi } from './uiPreferences'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let host: HTMLDivElement, root: Root, height: number, resize: () => void
let panes: ReturnType<typeof pane>[]
const pane = (factor: number) => ({
  getStretchFactor: () => factor,
  setStretchFactor: (next: number) => { factor = next },
  getHeight: (): number => height * factor / panes.reduce((sum, p) => sum + p.getStretchFactor(), 0),
})
const chart = { panes: () => panes } as unknown as IChartApi
function Harness({ session = 'one', slot = 0, enabled = true, timeframe = 'M5' }) {
  const container = useRef<HTMLDivElement>(null), chartRef = useRef(chart)
  useLayoutEffect(() => {
    if (enabled && panes.length === 1) panes.push(pane(1))
    if (!enabled) panes.splice(1)
  }, [enabled])
  useStochasticPaneHeight(container, chartRef, session, slot, enabled)
  return <div ref={container} data-timeframe={timeframe} />
}
const render = (props: Parameters<typeof Harness>[0] = {}) => act(async () => root.render(<StrictMode><Harness {...props} /></StrictMode>))
const share = () => panes[1].getStretchFactor() / (panes[0].getStretchFactor() + panes[1].getStretchFactor())
const stored = (session = 'one', slot = 0) => readUi(session, `stochasticPane:${slot}`, null as number | null, (v): v is number | null => v === null || validPaneShare(v))
const begin = () => host.firstElementChild!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
const move = (value: number) => { panes[0].setStretchFactor(1 - value); panes[1].setStretchFactor(value) }
const end = () => window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
const drag = (value: number) => { begin(); move(value); end() }
beforeEach(() => {
  localStorage.clear(); height = 600; panes = [pane(2), pane(1)]
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback } observe() {} disconnect() {} })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('uses the 3:1 default without writing during StrictMode initialization, resize, clicks or teardown', async () => {
  const writes = vi.spyOn(Storage.prototype, 'setItem')
  await render(); expect(share()).toBe(0.25)
  resize(); begin(); end(); window.dispatchEvent(new Event('pagehide'))
  await act(async () => root.unmount())
  expect(writes).not.toHaveBeenCalled()
})
it('saves only the completed native drag and restores it on a new mount', async () => {
  await render(); begin(); move(0.42)
  expect(stored()).toBeNull()
  end(); expect(stored()).toBeCloseTo(0.42)
  await act(async () => root.unmount())
  panes = [pane(2), pane(1)]; root = createRoot(host)
  await render(); expect(share()).toBeCloseTo(0.42)
})
it('retains the split through timeframe changes and oscillator removal/recreation', async () => {
  await render(); drag(0.4)
  await render({ timeframe: 'M15' }); expect(share()).toBeCloseTo(0.4)
  await render({ timeframe: 'H1', enabled: false }); expect(panes).toHaveLength(1)
  expect(stored()).toBeCloseTo(0.4)
  await render({ timeframe: 'M5' }); expect(share()).toBeCloseTo(0.4)
  await render({ enabled: false }); await render()
  expect(share()).toBeCloseTo(0.4)
})
it('isolates saved sessions and chart slots, including switching an existing chart between sessions', async () => {
  writeUi('two', 'stochasticPane:0', 0.6)
  await render(); drag(0.4)
  await render({ session: 'two' }); expect(share()).toBeCloseTo(0.6)
  drag(0.55)
  await render(); expect(share()).toBeCloseTo(0.4)
  for (const slot of [1, 2]) {
    await render({ slot }); expect(share()).toBe(0.25)
    drag(0.25 + slot * 0.1)
  }
  await render(); expect(share()).toBeCloseTo(0.4)
  expect(stored('one', 1)).toBeCloseTo(0.35); expect(stored('one', 2)).toBeCloseTo(0.45)
  expect(stored('two')).toBeCloseTo(0.55)
})
it('preserves intended proportions through container changes, clamping only display to native minimum heights', async () => {
  writeUi('one', 'stochasticPane:0', 0.1)
  await render(); expect(share()).toBeCloseTo(0.1)
  height = 200; resize()
  expect(panes[1].getHeight()).toBeCloseTo(30); expect(stored()).toBe(0.1)
  height = 1000; resize(); expect(share()).toBeCloseTo(0.1)
  height = 40; resize(); expect(share()).toBe(0.5)
  expect(stored()).toBe(0.1)
  height = 600; resize(); expect(share()).toBeCloseTo(0.1)
})
it.each([0, 1, -1, 2, NaN, Infinity, '0.4', null, {}, []])('ignores an invalid stored share %j without overwriting it during initialization', async value => {
  writeUi('one', 'stochasticPane:0', value)
  const original = localStorage.getItem(uiKey('one'))
  await render(); resize()
  expect(share()).toBe(0.25)
  expect(localStorage.getItem(uiKey('one'))).toBe(original)
})
it('does not save a temporary recreation or container clamp as a user resize', async () => {
  await render(); drag(0.1)
  begin(); height = 100; resize(); end()
  expect(stored()).toBeCloseTo(0.1)
  begin(); await render({ enabled: false }); end()
  await render(); expect(stored()).toBeCloseTo(0.1)
})
it('flushes a changed gesture on pagehide and removes listeners on unmount', async () => {
  await render(); begin(); move(0.4); window.dispatchEvent(new Event('pagehide'))
  expect(stored()).toBeCloseTo(0.4)
  await act(async () => root.unmount())
  move(0.6); end(); expect(stored()).toBeCloseTo(0.4)
})
