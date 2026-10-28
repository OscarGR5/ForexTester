import type { UTCTimestamp } from 'lightweight-charts'

export interface MeasurementAnchor { index: number; time: UTCTimestamp; price: number }
export interface Measurement { start: MeasurementAnchor; end: MeasurementAnchor }

// Search real, revealed candles, not the chart's projected/whitespace slots.
export function nearestMeasurementAnchor(candles: readonly { time: UTCTimestamp }[], logical: number | null,
  price: number | null, timeToLogical: (time: UTCTimestamp) => number | null): MeasurementAnchor | null {
  if (!candles.length || logical === null || !Number.isFinite(logical) || price === null || !Number.isFinite(price)) return null
  let low = 0, high = candles.length - 1
  while (low < high) {
    const middle = Math.floor((low + high) / 2), at = timeToLogical(candles[middle].time)
    if (at === null) return null
    if (at < logical) low = middle + 1; else high = middle
  }
  const right = timeToLogical(candles[low].time), left = low ? timeToLogical(candles[low - 1].time) : null
  if (right === null) return null
  const index = left !== null && Math.abs(logical - left) <= Math.abs(right - logical) ? low - 1 : low
  return { index, time: candles[index].time, price }
}

export function compactElapsed(seconds: number): string {
  const minutes = Math.floor(Math.abs(seconds) / 60), days = Math.floor(minutes / 1440)
  const hours = Math.floor(minutes % 1440 / 60), remaining = minutes % 60
  return [days ? `${days}d` : '', hours ? `${hours}h` : '', remaining ? `${remaining}m` : ''].filter(Boolean).join(' ') || '0m'
}

export function measurementMetrics({ start, end }: Measurement, pipSize: number) {
  const pips = (end.price - start.price) / pipSize
  const rounded = pips.toFixed(1)
  return { pips, pipLabel: `${Number(rounded) === 0 ? '0.0' : pips > 0 ? `+${rounded}` : rounded} pips`,
    spanLabel: `${Math.abs(end.index - start.index)} bars · ${compactElapsed(end.time - start.time)}` }
}
