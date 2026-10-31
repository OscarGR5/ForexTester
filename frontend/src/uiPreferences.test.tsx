// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defaultWorkspace, emptyOrderDraft, readUi, selectChartMode, uiKey, updateActiveChartMode, useUiValue, validOrderDraft, validWorkspace, writeUi } from './uiPreferences'
import { TradingPanel } from './TradingPanel'
import { createTradingState } from './trading'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())
it('restores layout, timeframe, indicators, zoom/following state and isolates sessions', () => {
  const settings = selectChartMode(defaultWorkspace(), 3)
  settings.viewport = { range: { from: 1700000000, to: 1700003600 }, following: false }
  writeUi('one', 'workspace', settings)
  expect(readUi('one', 'workspace', defaultWorkspace(), validWorkspace)).toEqual(settings)
  expect(readUi('two', 'workspace', defaultWorkspace(), validWorkspace)).toEqual(defaultWorkspace())
})
it('initializes the requested chart mode once and retains independent edits when switching', () => {
  let settings = defaultWorkspace()
  expect(settings).toMatchObject({ chartCount: 2, timeframes: ['H4', 'D1', 'H1'] })
  expect(settings.indicators[0].H4?.ichimoku.enabled).toBe(true)
  expect(settings.indicators[1].D1?.ichimoku.enabled).toBe(true)
  settings = selectChartMode(settings, 1)
  expect(settings.timeframes[0]).toBe('D1')
  const single = { ...settings.indicators[0], H1: settings.indicators[2].H1! }
  settings = updateActiveChartMode(settings, { timeframes: ['H1', ...settings.timeframes.slice(1)], indicators: [single, ...settings.indicators.slice(1)] })
  settings = selectChartMode(settings, 3)
  expect(settings.timeframes).toEqual(['M5', 'H4', 'H1'])
  expect(settings.indicators[0].M5).toMatchObject({ bollinger: { enabled: true, stdDev: 2 }, bollinger2: { enabled: true, stdDev: 1 }, stochastic: { enabled: true } })
  settings = selectChartMode(settings, 1)
  expect(settings.timeframes[0]).toBe('H1')
  expect(settings.indicators[0].H1?.ichimoku.enabled).toBe(true)
  expect(selectChartMode(settings, 2).timeframes).toEqual(['H4', 'D1', 'H1'])
})
it.each(['{', '[]', 'null', '{"workspace":{"chartCount":99}}', '{"workspace":{"timeframes":null}}'])('safely ignores invalid localStorage: %s', (raw) => {
  localStorage.setItem(uiKey('one'), raw)
  expect(readUi('one', 'workspace', defaultWorkspace(), validWorkspace)).toEqual(defaultWorkspace())
})
it('survives unavailable localStorage without touching trading state', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
  expect(() => writeUi('one', 'workspace', defaultWorkspace())).not.toThrow()
})
it('restores unsubmitted sizing and SL drafts in StrictMode without requesting any execution', async () => {
  writeUi('one', 'orderDraft', { ...emptyOrderDraft, mode: 'manual', volume: '0.34', stop: '1.09' })
  const host = document.createElement('div'), root = createRoot(host), onEntry = vi.fn(), state = createTradingState(1)
  const props = { state, permission: { active: true, playing: false, hasFuture: true }, onEntry, onConfigure: vi.fn(), onConfigureCommission: vi.fn(), onCancel: vi.fn(), onClose: vi.fn(), onModifyStop: vi.fn() }
  try {
    await act(async () => root.render(<StrictMode><TradingPanel sessionId="one" {...props} /></StrictMode>))
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Sizing mode"]')!.value).toBe('manual')
    expect([...host.querySelectorAll<HTMLInputElement>('input')].some((i) => i.value === '0.34')).toBe(true)
    expect(onEntry).not.toHaveBeenCalled(); expect(props.onModifyStop).not.toHaveBeenCalled()
    await act(async () => root.render(<StrictMode><TradingPanel sessionId="two" {...props} /></StrictMode>))
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Sizing mode"]')!.value).toBe('risk')
    expect(onEntry).not.toHaveBeenCalled()
  } finally { await act(async () => root.unmount()) }
})

it('restores four panes in row order and retains all four modes independently, including legacy settings', () => {
  const legacy = { ...defaultWorkspace(), chartModes: undefined }
  let workspace = selectChartMode(legacy, 4)
  expect(workspace.timeframes).toEqual(['H1', 'D1', 'M5', 'H4'])
  expect(validWorkspace(workspace)).toBe(true)
  workspace = updateActiveChartMode(workspace, { timeframes: ['H1', 'D1', 'M15', 'H4'],
    indicators: workspace.indicators.map((groups, index) => index === 2 ? { M15: groups.M5! } : groups) })
  for (const count of [1, 2, 3, 4] as const) {
    workspace = selectChartMode(workspace, count)
    expect(validWorkspace(workspace)).toBe(true)
    writeUi('four', 'workspace', workspace)
    expect(readUi('four', 'workspace', defaultWorkspace(), validWorkspace)).toEqual(workspace)
  }
  expect(workspace.timeframes).toEqual(['H1', 'D1', 'M15', 'H4'])
  expect(validWorkspace({ ...workspace, timeframes: workspace.timeframes.slice(0, 3) })).toBe(false)
})
