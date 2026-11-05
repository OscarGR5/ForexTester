import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { validViewportState } from './chartSync'
import { TIMEFRAMES } from './history'
import { defaultIndicatorSettings, indicatorPreset, validateIndicatorSettings } from './indicators'
import type { ChartModeSettings, WorkspaceSettings } from './sessionTypes'

export function defaultChartMode(count: 1 | 2 | 3 | 4): ChartModeSettings {
  const timeframes = count === 4 ? ['H1', 'D1', 'M5', 'H4'] as const : count === 1 ? ['D1', 'H4', 'H1'] as const : count === 2 ? ['H4', 'D1', 'H1'] as const : ['M5', 'H4', 'H1'] as const
  return { timeframes: [...timeframes], indicators: timeframes.map(timeframe => ({ [timeframe]: indicatorPreset(timeframe) })) }
}
export const defaultWorkspace = (): WorkspaceSettings => {
  const chartModes = { '1': defaultChartMode(1), '2': defaultChartMode(2), '3': defaultChartMode(3), '4': defaultChartMode(4) }
  return { chartCount: 2, ...chartModes['2'], chartModes, statisticsScope: 'setups', journalScope: 'setups', viewport: null }
}
export function selectChartMode(workspace: WorkspaceSettings, chartCount: 1 | 2 | 3 | 4): WorkspaceSettings {
  const current = String(workspace.chartCount) as '1' | '2' | '3' | '4'
  const target = String(chartCount) as '1' | '2' | '3' | '4'
  const chartModes = { ...workspace.chartModes,
    [current]: { timeframes: workspace.timeframes, indicators: workspace.indicators } }
  const selected = chartModes[target] ?? defaultChartMode(chartCount)
  return { ...workspace, chartCount, timeframes: selected.timeframes, indicators: selected.indicators,
    chartModes: { ...chartModes, [target]: selected } }
}
export function updateActiveChartMode(workspace: WorkspaceSettings, update: Pick<ChartModeSettings, 'timeframes' | 'indicators'>): WorkspaceSettings {
  const current = String(workspace.chartCount) as '1' | '2' | '3' | '4'
  return { ...workspace, ...update, chartModes: { ...workspace.chartModes, [current]: update } }
}
export const UI_PREFIX = 'forextester:ui:v1:'
export const GLOBAL_UI_ID = 'global'
export const uiKey = (id: string) => `${UI_PREFIX}${id}`
export function validWorkspace(value: unknown): value is WorkspaceSettings {
  try {
    const w = value as WorkspaceSettings
    if (!w || ![1, 2, 3, 4].includes(w.chartCount) || w.timeframes.length !== (w.chartCount === 4 ? 4 : 3) || w.indicators.length !== w.timeframes.length ||
      !w.timeframes.every((tf) => TIMEFRAMES.includes(tf)) || !['setups', 'positions'].includes(w.statisticsScope) || !['setups', 'positions'].includes(w.journalScope)) return false
    const validMode = (mode: ChartModeSettings, count: number) => {
      if (!mode || mode.timeframes.length !== (count === 4 ? 4 : 3) || mode.indicators.length !== mode.timeframes.length || !mode.timeframes.every((tf) => TIMEFRAMES.includes(tf))) return false
      for (const [i, groups] of mode.indicators.entries()) {
        if (!groups[mode.timeframes[i]]) return false
        for (const [tf, settings] of Object.entries(groups)) {
          if (!TIMEFRAMES.includes(tf as typeof TIMEFRAMES[number]) || !settings || validateIndicatorSettings(settings)) return false
          for (const [group, fields] of Object.entries(defaultIndicatorSettings())) for (const [key, sample] of Object.entries(fields)) {
            if (typeof (settings as unknown as Record<string, Record<string, unknown>>)[group]?.[key] !== typeof sample) return false
          }
        }
      }
      return true
    }
    if (!validMode(w, w.chartCount)) return false
    if (w.chartModes !== undefined && (typeof w.chartModes !== 'object' || Object.entries(w.chartModes).some(([count, mode]) => !['1','2','3','4'].includes(count) || !validMode(mode!, Number(count))))) return false
    return w.viewport === null || validViewportState(w.viewport)
  } catch { return false }
}
function readEnvelope(id: string): Record<string, unknown> {
  try {
    const raw = window.localStorage.getItem(uiKey(id))
    if (!raw || raw.length > 100_000) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch { return {} }
}
export function readUi<T>(id: string | null, field: string, fallback: T, validate: (v: unknown) => v is T): T {
  const value = id ? readEnvelope(id)[field] : null
  return validate(value) ? value : fallback
}
export function writeUi(id: string | null, field: string, value: unknown) {
  if (!id) return
  try { window.localStorage.setItem(uiKey(id), JSON.stringify({ ...readEnvelope(id), [field]: value })) } catch { /* Presentation storage must never prevent trading or disk saves. */ }
}
export function useUiValue<T>(id: string | null, field: string, fallback: T, validate: (v: unknown) => v is T): [T, (next: T | ((v: T) => T)) => void] {
  const [slot, setSlot] = useState(() => ({ id, value: readUi(id, field, fallback, validate) }))
  const value = slot.id === id ? slot.value : readUi(id, field, fallback, validate)
  const current = useRef(value)
  useLayoutEffect(() => { current.current = value; if (slot.id !== id) setSlot({ id, value }) }, [id, value, slot.id])
  const update = useCallback((next: T | ((v: T) => T)) => {
    const value = typeof next === 'function' ? (next as (v: T) => T)(current.current) : next
    current.current = value; setSlot({ id, value }); writeUi(id, field, value)
  }, [id, field])
  return [value, update]
}
export interface OrderDraft { mode: 'risk' | 'manual'; risk: string; volume: string; stop: string; setupId: string | null }
export const emptyOrderDraft: OrderDraft = { mode: 'risk', risk: '1', volume: '0.01', stop: '', setupId: null }
export function validOrderDraft(v: unknown): v is OrderDraft {
  const d = v as OrderDraft
  return !!d && ['risk', 'manual'].includes(d.mode) && [d.risk, d.volume, d.stop].every((s) => typeof s === 'string' && s.length <= 64 && (s === '' || Number.isFinite(Number(s)))) && (d.setupId === null || typeof d.setupId === 'string' && d.setupId.length <= 128)
}
export const validSelection = (v: unknown): v is string | null => v === null || typeof v === 'string' && v.length <= 128
export const validBoolean = (v: unknown): v is boolean => typeof v === 'boolean'
export const validPaneShare = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1
export interface PriceView { autoScale: boolean; range: { from: number; to: number } | null }
export const validPriceView = (v: unknown): v is PriceView => {
  const p = v as PriceView
  return !!p && typeof p.autoScale === 'boolean' && (p.range === null || Number.isFinite(p.range.from) && Number.isFinite(p.range.to) && p.range.from > 0 && p.range.from < p.range.to)
}
