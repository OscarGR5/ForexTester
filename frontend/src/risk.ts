// USD reference balance is a fixed sizing input, never simulated equity.
export interface AccountRisk { referenceBalance: number; maxRiskPercent: number }
export const DEFAULT_ACCOUNT_RISK: AccountRisk = { referenceBalance: 100_000, maxRiskPercent: 2 }
export const AUTO_LOT_INCREMENT = 0.01
export const AUTO_LOT_MINIMUM = 0.01
export type EntrySizing = number | { mode: 'risk'; riskPercent: number }
export const positiveFinite = (value: number) => Number.isFinite(value) && value > 0
export const validRiskPercent = (value: number) => positiveFinite(value) && value <= 100
export const riskBudget = (balance: number, percent: number) => balance * (percent / 100)

export function accountRiskError(account: AccountRisk): string | null {
  if (!positiveFinite(account.referenceBalance)) return 'Enter a positive, finite reference balance in USD.'
  if (!validRiskPercent(account.maxRiskPercent)) return 'Maximum combined risk must be greater than 0 and at most 100%.'
  return null
}

export function plannedRisk(position: { direction: 'buy' | 'sell'; entryPrice: number; stopPrice: number; lots: number }): number {
  const distance = (position.entryPrice - position.stopPrice) * (position.direction === 'buy' ? 1 : -1)
  return Math.max(0, distance) * 100_000 * position.lots
}

// Comparisons allow only floating-point arithmetic noise, never a cent of extra budget.
export function exceedsRisk(amount: number, budget: number): boolean {
  return !Number.isFinite(amount) || amount - budget > Math.min(1e-8, Number.EPSILON * 16 * Math.max(1, amount, budget))
}

export function sizeFromRisk(budget: number, entryPrice: number, stopPrice: number): number | null {
  if (![budget, entryPrice, stopPrice].every(positiveFinite) || entryPrice === stopPrice) return null
  const perLot = Math.abs(entryPrice - stopPrice) * 100_000
  const units = budget / perLot / AUTO_LOT_INCREMENT
  if (!Number.isFinite(units) || units > Number.MAX_SAFE_INTEGER) return null
  // Correct representation noise at exact increment boundaries (e.g. 20 pips).
  let lots = Math.floor(units + Number.EPSILON * 16 * Math.max(1, units)) / 100
  if (exceedsRisk(perLot * lots, budget)) lots = (Math.round(lots * 100) - 1) / 100
  return lots >= AUTO_LOT_MINIMUM && positiveFinite(lots) ? lots : null
}
