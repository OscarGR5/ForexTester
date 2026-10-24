import { DatabentoClient, IDENTITY } from '../backend/src/databento.js'
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
export class FixtureDatabento extends DatabentoClient {
  paid: { from: string; to: string }[] = []
  metadataCalls: string[] = []
  estimateUsd = .02
  failDownload = false
  dense = false
  roll = '2024-01-09'
  constructor() { super('fixture-key-never-used') }
  override async availability() { this.metadataCalls.push('availability'); return { start: '2010-06-06T00:00:00Z', end: '2025-01-01T00:00:00Z' } }
  override async contracts(from: string, to: string) { this.metadataCalls.push('contracts'); return fixtureHistory(from, to, this.roll).contracts }
  override async cost(_from: string, _to: string) { this.metadataCalls.push('cost'); return this.estimateUsd }
  override async download(from: string, to: string, _contracts: ContractInterval[]) {
    this.paid.push({ from, to })
    if (this.failDownload) throw Error('Fixture interruption')
    const history = fixtureHistory(from, to, this.roll, this.dense)
    return { history, metrics: { downloadBytes: JSON.stringify(history).length, durationMs: 1, candles: history.candles.length } }
  }
}
export const creditEnv = { DATABENTO_CREDITS_USD: '121.35', DATABENTO_CREDITS_VERIFIED_AT: '2024-04-01T00:00:00Z', DATABENTO_CREDITS_EXPIRE_AT: '2025-01-01T00:00:00Z' }
export const fixtureNow = () => new Date('2024-04-01T12:00:00Z')
