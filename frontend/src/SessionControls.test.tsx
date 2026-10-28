// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SessionControls } from './SessionControls'
import type { SessionRecord } from './sessionTypes'

function sessionFixture(): Parameters<typeof SessionControls>[0]['sessions'] {
  return {
    sessions: [{ id: 'broken', name: { invalid: true }, savedAt: 'bad date', range: { from: {}, to: null }, completedSetups: {}, totalCandles: {}, checkpoint: { replay: { index: {}, startIndex: {}, started: true } } } as unknown as SessionRecord],
    uiCleanupPreview: null, uiCleanupResult: null, preferenceNotice: null, previewPreferences: vi.fn(), cleanupPreferences: vi.fn(),
    repairTarget: null, repairProgress: null, repair: vi.fn(), cleanupPreview: null, cleanupResult: null, previewCleanup: vi.fn(), cleanup: vi.fn(),
    diskErrors: [], legacySessions: [], storageLocation: '/tmp/test-storage', migrationWarning: null, migrate: vi.fn(), retry: vi.fn(),
    name: 'Untitled backtest', savedAt: null, saveStatus: 'Error', error: 'Saved session is corrupt', cacheWarning: null,
    conflict: false, busy: false, initialized: true, awaitingChoice: true, activeId: null,
    flush: vi.fn(), editName: vi.fn(), rename: vi.fn(), remove: vi.fn(), resume: vi.fn(), fresh: vi.fn(), save: vi.fn(),
  }
}

it('keeps corrupt metadata visible and explicitly deletable without rendering objects or invalid numbers', () => {
  const sessions = sessionFixture()
  const html = renderToStaticMarkup(<SessionControls sessions={sessions} range={{ from: '2024-01-01', to: '2024-01-02' }} timestamp={null} />)
  expect(html).toContain('Unreadable session'); expect(html).toContain('Unknown completed setups'); expect(html).toContain('Delete')
  expect(html).not.toContain('NaN')
})

describe.each([false, true])('Advanced maintenance (startup: %s)', startup => {
  it('starts collapsed, opens and closes, and retains both cleanup previews', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const sessions = sessionFixture()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () => root.render(<SessionControls sessions={sessions} startup={startup} range={{ from: '2024-01-01', to: '2024-01-02' }} timestamp={null} />))
      const advanced = host.querySelector<HTMLDetailsElement>('.storage-maintenance')!
      const summary = advanced.querySelector('summary')!
      const button = (name: string) => [...advanced.querySelectorAll('button')].find(button => button.textContent === name)!
      expect(summary.textContent).toBe('Advanced')
      expect(advanced.open).toBe(false)
      expect(advanced.querySelector('h2')?.textContent).toBe('Storage maintenance')
      expect(sessions.previewPreferences).not.toHaveBeenCalled()
      expect(sessions.previewCleanup).not.toHaveBeenCalled()
      expect(sessions.cleanupPreferences).not.toHaveBeenCalled()
      expect(sessions.cleanup).not.toHaveBeenCalled()

      await act(async () => summary.click())
      expect(advanced.open).toBe(true)
      await act(async () => button('Clean up unused UI preferences').click())
      await act(async () => button('Preview cleanup').click())
      expect(sessions.previewPreferences).toHaveBeenCalledOnce()
      expect(sessions.previewCleanup).toHaveBeenCalledOnce()
      expect(button('Confirm UI preference cleanup')).toBeUndefined()
      expect(button('Clean up unused files')).toBeUndefined()

      await act(async () => summary.click())
      expect(advanced.open).toBe(false)
      await act(async () => summary.click())
      expect(advanced.open).toBe(true)
      expect(sessions.previewPreferences).toHaveBeenCalledOnce()
      expect(sessions.previewCleanup).toHaveBeenCalledOnce()
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  })
})
