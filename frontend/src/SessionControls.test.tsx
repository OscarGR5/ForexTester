import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SessionControls } from './SessionControls'
import type { SessionRecord } from './sessionTypes'

it('keeps corrupt metadata visible and explicitly deletable without rendering objects or invalid numbers', () => {
  const sessions: Parameters<typeof SessionControls>[0]['sessions'] = {
    sessions: [{ id: 'broken', name: { invalid: true }, savedAt: 'bad date', range: { from: {}, to: null }, completedSetups: {}, totalCandles: {}, checkpoint: { replay: { index: {}, startIndex: {}, started: true } } } as unknown as SessionRecord],
    diskErrors: [], legacySessions: [], storageLocation: '/tmp/test-storage', migrationWarning: null, migrate: vi.fn(), retry: vi.fn(),
    name: 'Untitled backtest', savedAt: null, saveStatus: 'Error', error: 'Saved session is corrupt', cacheWarning: null,
    conflict: false, busy: false, initialized: true, awaitingChoice: true, activeId: null,
    editName: vi.fn(), rename: vi.fn(), remove: vi.fn(), resume: vi.fn(), fresh: vi.fn(), save: vi.fn(),
  }
  const html = renderToStaticMarkup(<SessionControls sessions={sessions} range={{ from: '2024-01-01', to: '2024-01-02' }} timestamp={null} />)
  expect(html).toContain('Unreadable session'); expect(html).toContain('Unknown completed setups'); expect(html).toContain('Delete')
  expect(html).not.toContain('NaN')
})
