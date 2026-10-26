// Read-only legacy cache recovery. Saved history objects remain authoritative.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { providerCachePaths } from './projectPaths.js'
import { DataError } from './historyErrors.js'
import { isFuturesHistory, parseHistory, type ContractInterval, type SinglePriceHistory } from '../../frontend/src/history.js'
type Range = {from: string; to: string}
const DAY = 86400000
const day = (ms: number) => new Date(ms).toISOString().slice(0,10)
const dateMs = (date: string) => Date.parse(date)
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const LEGACY_IDENTITY = { priceModel: 'single', source: 'databento', symbol: '6E', dataset: 'GLBX.MDP3', schema: 'ohlcv-1m', continuousSymbol: '6E.v.0', stypeIn: 'continuous', normalizationVersion: 1, resolution: 'M1' } as const
export class LegacyHistoryCache {
  constructor(private directory?: string) {}
  private async root() { return this.directory ?? (await providerCachePaths()).cacheFolderPath }
  private validate(from: string, to: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || day(dateMs(from)) !== from || day(dateMs(to)) !== to || from >= to || dateMs(to)-dateMs(from)>120*DAY) throw new DataError('INVALID_HISTORY_RANGE','Invalid legacy cache range.')
  }
  private async cachedDay(from: string): Promise<SinglePriceHistory | null> {
    try {
      const root = await this.root(), ref = JSON.parse(await readFile(join(root, `${from}.ref.json`), 'utf8')) as { id: string }
      if (!/^[a-f0-9]{64}$/.test(ref.id)) throw Error()
      const envelope = JSON.parse(await readFile(join(root, `${ref.id}.json`), 'utf8')) as { history: unknown; digest: string }
      if (envelope.digest !== hash(envelope.history)) throw Error()
      const history = parseHistory(envelope.history, { from, to: day(dateMs(from) + DAY) })
      if (!isFuturesHistory(history) || ref.id !== hash({ ...LEGACY_IDENTITY, from: history.from, to: history.to, contracts: history.contracts })) throw Error()
      return history
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new DataError('CACHE_CORRUPT', 'A Databento cache object failed validation. Original files were retained; no replacement was downloaded.', 503)
    }
  }
  async readCached(from: string, to: string): Promise<SinglePriceHistory> {
    this.validate(from, to)
    const parts: SinglePriceHistory[] = []
    for (let time = dateMs(from); time < dateMs(to); time += DAY) {
      const part = await this.cachedDay(day(time))
      if (!part) throw new DataError('HISTORY_NOT_CACHED', 'The requested Databento history is not fully cached. Restore the original cache from backup.', 409)
      parts.push(part)
    }
    const contracts: ContractInterval[] = []
    for (const part of parts) for (const contract of part.contracts) {
      const previous = contracts.at(-1)
      if (previous && previous.to === contract.from && previous.instrumentId === contract.instrumentId && previous.rawSymbol === contract.rawSymbol) previous.to = contract.to
      else contracts.push({ ...contract })
    }
    return parseHistory({ ...LEGACY_IDENTITY, from, to, contracts, candles: parts.flatMap(p => p.candles) }, { from, to }) as SinglePriceHistory
  }
}
