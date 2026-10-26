const IDENTITY = { priceModel: 'single', source: 'databento', symbol: '6E', dataset: 'GLBX.MDP3', schema: 'ohlcv-1m', continuousSymbol: '6E.v.0', stypeIn: 'continuous', normalizationVersion: 1, resolution: 'M1' } as const
import type { SinglePriceHistory, ContractInterval } from '../frontend/src/history.js'
export function fixtureHistory(from: string, to: string, roll?: string, dense = false): SinglePriceHistory {
  const contracts: ContractInterval[] = roll && roll > from && roll < to
    ? [{ from, to: roll, instrumentId: 101, rawSymbol: '6EH4' }, { from: roll, to, instrumentId: 202, rawSymbol: '6EM4' }]
    : [{ from, to, instrumentId: 101, rawSymbol: '6EH4' }]
  const candles: SinglePriceHistory['candles'] = []
  for (let timestamp = Date.parse(from); timestamp < Date.parse(to); timestamp += dense ? 60000 : 86400000) {
    const instrumentId = contracts.find(c => timestamp >= Date.parse(c.from) && timestamp < Date.parse(c.to))!.instrumentId
    const open = instrumentId === 101 ? 1.1 : 1.2
    candles.push({ timestamp, open, high: open + .001, low: open - .001, close: open + .0001, volume: '123', instrumentId })
  }
  return { ...IDENTITY, from, to, contracts, candles }
}

export const fixtureNow = () => new Date('2024-04-01T12:00:00Z')
