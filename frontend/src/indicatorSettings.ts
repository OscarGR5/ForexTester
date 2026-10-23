import type { Timeframe } from './history.js'

export interface BollingerSettings {
  enabled: boolean; length: number; stdDev: number
  basisVisible: boolean; upperVisible: boolean; lowerVisible: boolean
}
export interface IndicatorSettings {
  bollinger: BollingerSettings
  bollinger2: BollingerSettings
  stochastic: { enabled: boolean; length: number; smoothK: number; smoothD: number }
  ichimoku: { enabled: boolean; tenkan: number; kijun: number; spanB: number; displacement: number }
}
export function defaultIndicatorSettings(): IndicatorSettings {
  return {
    bollinger: { enabled: false, length: 20, stdDev: 2, basisVisible: true, upperVisible: true, lowerVisible: true },
    bollinger2: { enabled: false, length: 20, stdDev: 1, basisVisible: false, upperVisible: true, lowerVisible: true },
    stochastic: { enabled: false, length: 30, smoothK: 10, smoothD: 10 },
    ichimoku: { enabled: false, tenkan: 9, kijun: 26, spanB: 52, displacement: 26 },
  }
}
export function indicatorPreset(timeframe: Timeframe): IndicatorSettings {
  const settings = defaultIndicatorSettings()
  if (timeframe === 'M5' || timeframe === 'M15') {
    settings.bollinger.enabled = true
    settings.bollinger2.enabled = true
    settings.stochastic.enabled = true
  } else if (timeframe === 'H1' || timeframe === 'H4') {
    settings.ichimoku.enabled = true
  }
  return settings
}
export function validateIndicatorSettings(settings: IndicatorSettings): string | null {
  for (const [name, group] of Object.entries(settings)) {
    for (const [key, value] of Object.entries(group)) {
      if (['enabled', 'basisVisible', 'upperVisible', 'lowerVisible'].includes(key)) continue
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 ||
        (key === 'stdDev' ? value > 100 : !Number.isInteger(value) || value > 10000)) {
        return `${name}: ${key} must be ${key === 'stdDev' ? 'greater than 0 and at most 100' : 'a whole number from 1 to 10000'}.`
      }
    }
  }
  return null
}
