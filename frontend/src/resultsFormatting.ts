export function decimal(value: number | null | undefined, digits = 2, signed = false): string {
  if (value == null || !Number.isFinite(value)) return 'N/A'
  const rounded = Number(value.toFixed(digits)) || 0
  return `${signed && rounded > 0 ? '+' : ''}${rounded.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}
export function usd(value: number | null | undefined, signed = false): string {
  if (value == null || !Number.isFinite(value)) return 'N/A'
  const rounded = Number(value.toFixed(2)) || 0
  return `${rounded < 0 ? '-' : signed && rounded > 0 ? '+' : ''}$${decimal(Math.abs(rounded))}`
}
export const percent = (value: number | null | undefined, signed = false) => value == null || !Number.isFinite(value) ? 'N/A' : `${decimal(value, 2, signed)}%`
export const rValue = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? 'N/A' : `${decimal(value, 2, true)}R`
export const profitFactor = (value: number | null) => value === Infinity ? '∞' : decimal(value)
export const outcomeClass = (value: number | null) => value === null || value === 0 ? '' : value > 0 ? 'positive' : 'negative'
export function duration(value: number | null) {
  if (value === null || !Number.isFinite(value) || value < 0) return 'N/A'
  const minutes = value / 60_000
  return minutes < 60 ? `${decimal(minutes, 1)} min` : minutes < 1440 ? `${decimal(minutes / 60, 1)} h` : `${decimal(minutes / 1440, 1)} days`
}
