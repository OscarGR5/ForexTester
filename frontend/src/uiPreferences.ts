import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { validViewportState } from './chartSync'
import { TIMEFRAMES } from './history'
import { defaultIndicatorSettings, indicatorPreset, validateIndicatorSettings } from './indicators'
import type { WorkspaceSettings } from './sessionTypes'

export const defaultWorkspace = (): WorkspaceSettings => ({ chartCount: 1, timeframes: ['H1', 'M5', 'H4'],
  indicators: [{ H1: indicatorPreset('H1') }, { M5: indicatorPreset('M5') }, { H4: indicatorPreset('H4') }], statisticsScope: 'setups', journalScope: 'setups', viewport: null })
export const UI_PREFIX = 'forextester:ui:v1:'
export const uiKey = (id: string) => `${UI_PREFIX}${id}`
export function validWorkspace(value: unknown): value is WorkspaceSettings {
  try {
    const w = value as WorkspaceSettings
    if (!w || ![1, 2, 3].includes(w.chartCount) || w.timeframes.length !== 3 || w.indicators.length !== 3 ||
      !w.timeframes.every((tf) => TIMEFRAMES.includes(tf)) || !['setups', 'positions'].includes(w.statisticsScope) || !['setups', 'positions'].includes(w.journalScope)) return false
    for (const [i, groups] of w.indicators.entries()) {
      if (!groups[w.timeframes[i]]) return false
      for (const [tf, settings] of Object.entries(groups)) {
        if (!TIMEFRAMES.includes(tf as typeof TIMEFRAMES[number]) || !settings || validateIndicatorSettings(settings)) return false
        for (const [group, fields] of Object.entries(defaultIndicatorSettings())) for (const [key, sample] of Object.entries(fields)) {
          if (typeof (settings as unknown as Record<string, Record<string, unknown>>)[group]?.[key] !== typeof sample) return false
        }
      }
    }
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
export interface PriceView { autoScale: boolean; range: { from: number; to: number } | null }
export const validPriceView = (v: unknown): v is PriceView => {
  const p = v as PriceView
  return !!p && typeof p.autoScale === 'boolean' && (p.range === null || Number.isFinite(p.range.from) && Number.isFinite(p.range.to) && p.range.from > 0 && p.range.from < p.range.to)
}
