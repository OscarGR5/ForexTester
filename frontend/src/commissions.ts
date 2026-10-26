// User-entered USD rate for one standard FX lot, covering entry and exit.
export interface CommissionConfig { roundTripUsdPerLot: number }
export const DEFAULT_COMMISSION: CommissionConfig = { roundTripUsdPerLot: 7 }

export function commissionConfigError(config: CommissionConfig): string | null {
  return Number.isFinite(config.roundTripUsdPerLot) && config.roundTripUsdPerLot >= 0
    ? null : 'Enter a finite, nonnegative round-trip commission in USD per standard lot.'
}

// No ticket minimums or monetary rounding. Round only at the display boundary.
export function perSideCommissionUsd(lots: number, config: CommissionConfig): number {
  return lots * (config.roundTripUsdPerLot / 2)
}
