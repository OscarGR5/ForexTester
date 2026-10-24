// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defaultWorkspace, emptyOrderDraft, readUi, uiKey, useUiValue, validOrderDraft, validWorkspace, writeUi } from './uiPreferences'
import { TradingPanel } from './TradingPanel'
import { createTradingState } from './trading'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())
it('restores layout, timeframe, indicators, zoom/following state and isolates sessions', () => {
  const settings = defaultWorkspace(); settings.chartCount = 3; settings.timeframes[0] = 'H4'; settings.indicators[0].H4 = settings.indicators[2].H4
  settings.viewport = { range: { from: 1700000000, to: 1700003600 }, following: false }
  writeUi('one', 'workspace', settings)
  expect(readUi('one', 'workspace', defaultWorkspace(), validWorkspace)).toEqual(settings)
  expect(readUi('two', 'workspace', defaultWorkspace(), validWorkspace)).toEqual(defaultWorkspace())
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
