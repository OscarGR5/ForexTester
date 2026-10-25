import { createEquityLedger, type EquityPoint } from '../frontend/src/equity'

// Display-only fixed observations. No engine, provider, or session storage.
export function resultsContinuityFixture() {
  const time = (date: string) => Date.parse(date + 'Z')
  let peak = 10000
  const point = (date: string, equityUsd: number | null, cashUsd: number, clockGap = false): EquityPoint => {
    peak = Math.max(peak, equityUsd ?? peak)
    return {
      timestamp: time(date), equityUsd, cashUsd, clockGap,
      unrealizedUsd: equityUsd === null ? null : equityUsd - cashUsd,
      drawdownUsd: equityUsd === null ? null : peak - equityUsd,
      drawdownPercent: equityUsd === null ? null : (peak - equityUsd) / peak * 100,
      missingSides: equityUsd === null ? ['bid'] : [],
    }
  }
  const points = [
    point('2024-01-03T23:59', 10000, 10000),
    point('2024-01-04T00:00', 10000, 10000),
    point('2024-01-05T20:59', 10200, 10000, true),
    point('2024-01-05T21:00', 9350, 10000),
    point('2024-01-08T00:00', 9200, 10000, true), // held weekend, changing equity and nonzero DD
    point('2024-01-08T00:01', 9250, 10000),
    point('2024-01-08T00:05', 9100, 10000, true), // missing M1 observations
    point('2024-01-08T00:06', null, 10000),
    point('2024-01-08T00:07', null, 10000),
    point('2024-01-08T00:08', 9300, 10000), // unavailable marks recover at a different value
    point('2024-01-08T00:09', 9350, 10000),
    point('2024-01-08T00:10', 9500, 9500), // exit
    point('2024-01-12T21:00', 9500, 9500, true),
    point('2024-01-15T00:00', 9500, 9500, true), // flat weekend with nonzero drawdown
    point('2024-01-15T00:01', 9500, 9500),
  ]
  let ledger = createEquityLedger(10000)
  for (const point of points) ledger = { ...ledger, count: ledger.count + 1, tail: { point, previous: ledger.tail } }
  const positions = [{ entryTime: time('2024-01-05T20:59'), exitTime: time('2024-01-08T00:10') }]
  return { ledger, points, positions }
}
