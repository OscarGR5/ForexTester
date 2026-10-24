import { isRecord, parseHistory, type ContractInterval, type SinglePriceHistory, type TradeCandle } from '../../frontend/src/history.js'

export const IDENTITY = { priceModel: 'single', source: 'databento', symbol: '6E', dataset: 'GLBX.MDP3', schema: 'ohlcv-1m',
  continuousSymbol: '6E.v.0', stypeIn: 'continuous', normalizationVersion: 1, resolution: 'M1' } as const
export class DataError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message) }
}
const invalid = (message: string): never => { throw new DataError('INVALID_PROVIDER_DATA', message, 502) }
export const day = (time: number) => new Date(time).toISOString().slice(0, 10)
export function dateMs(value: string): number {
  const result = Date.parse(value)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(result) || day(result) !== value) throw new DataError('INVALID_HISTORY_RANGE', 'Use valid UTC calendar dates.')
  return result
}
function intervals(value: unknown, symbol: string, from: string, to: string): { from: string; to: string; symbol: string }[] {
  if (!isRecord(value) || value.status !== 0 || !Array.isArray(value.partial) || value.partial.length || !Array.isArray(value.not_found) || value.not_found.length ||
    !isRecord(value.result) || !Array.isArray(value.result[symbol])) return invalid('Databento could not completely resolve the requested symbol.')
  let boundary = from
  const items: { from: string; to: string; symbol: string }[] = []
  for (const item of value.result[symbol]) {
    if (!isRecord(item) || typeof item.d0 !== 'string' || typeof item.d1 !== 'string' || typeof item.s !== 'string') return invalid('Malformed symbol mapping.')
    dateMs(item.d0); dateMs(item.d1)
    if (item.d1 <= item.d0) return invalid('Invalid symbol interval.')
    // Weekend requests may resolve from the prior trading date. Clip only the
    // verified interval boundaries; never extrapolate a missing mapping.
    const start = item.d0 < from ? from : item.d0, end = item.d1 > to ? to : item.d1
    if (start >= end) continue
    if (start !== boundary) return invalid('Overlapping or incomplete symbol mapping.')
    boundary = end
    items.push({ from: start, to: end, symbol: item.s })
  }
  if (boundary !== to || !items.length) return invalid('Incomplete symbol mapping.')
  return items
}
export function decodeJsonLines(text: string, from: string, to: string, contracts: ContractInterval[]): SinglePriceHistory {
  const candles: TradeCandle[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let item: unknown
    try { item = JSON.parse(line) } catch { return invalid('Malformed Databento JSON record.') }
    if (!isRecord(item) || !isRecord(item.hd) || item.hd.rtype !== 33 || item.hd.publisher_id !== 1 ||
      typeof item.hd.ts_event !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:00(?:\.0{1,9})?Z$/.test(item.hd.ts_event)) return invalid('Unexpected OHLCV header or timestamp.')
    const timestamp = Date.parse(item.hd.ts_event)
    if (new Date(timestamp).toISOString().slice(0, 19) !== item.hd.ts_event.slice(0, 19)) return invalid('Invalid UTC timestamp.')
    const prices = ['open', 'high', 'low', 'close'].map(key => {
      const value = item[key]
      if (typeof value !== 'string' || !/^\d+\.\d{1,9}$/.test(value)) return invalid('Expected scaled decimal trade prices.')
      return Number(value)
    })
    candles.push({ timestamp, open: prices[0], high: prices[1], low: prices[2], close: prices[3],
      volume: item.volume as string, instrumentId: item.hd.instrument_id as number })
  }
  // Strict validation rejects all duplicate records, even identical ones; no silent reordering.
  return parseHistory({ ...IDENTITY, from, to, contracts, candles }, { from, to }) as SinglePriceHistory
}

export class DatabentoClient {
  constructor(private key = process.env.DATABENTO_API_KEY, private http: typeof fetch = fetch) {}
  get configured() { return !!this.key }
  private async request(method: string, params: Record<string, string>, post = false, maxBytes = 2 * 1024 * 1024): Promise<string> {
    if (!this.key) throw new DataError('DATABENTO_CONFIGURATION', 'Set DATABENTO_API_KEY in the backend environment. See README; never enter the key in the browser.', 503)
    const query = new URLSearchParams(params)
    let response: Response
    try {
      response = await this.http(`https://hist.databento.com/v0/${method}${post ? '' : `?${query}`}`, {
        method: post ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(180_000),
        headers: { Authorization: `Basic ${Buffer.from(`${this.key}:`).toString('base64')}`, ...(post ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
        body: post ? query : undefined,
      })
    } catch { throw new DataError('DATABENTO_NETWORK', 'Databento request failed. Downloads are never retried automatically; an interrupted paid request remains reserved against the budget.', 502) }
    if (!response.ok) {
      await response.body?.cancel()
      throw new DataError(response.status === 401 ? 'DATABENTO_AUTH' : response.status === 403 ? 'DATABENTO_ACCESS' : 'DATABENTO_HTTP',
        `Databento returned HTTP ${response.status}. Check credentials, dataset access or account status. No automatic retry.`, 502)
    }
    if (!response.body) return invalid('Databento returned no response body.')
    const reader = response.body.getReader(), chunks: Uint8Array[] = []
    let bytes = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > maxBytes) { await reader.cancel(); return invalid('Databento response exceeded the bounded download size.') }
        chunks.push(value)
      }
    } catch (error) {
      if (error instanceof DataError) throw error
      throw new DataError('DATABENTO_INTERRUPTED', 'Databento response was interrupted. Partial data was not cached; its budget reservation remains.', 502)
    }
    return Buffer.concat(chunks).toString('utf8')
  }
  private async json(method: string, params: Record<string, string>, post = false): Promise<unknown> {
    const text = await this.request(method, params, post)
    try { return JSON.parse(text) } catch { return invalid('Malformed Databento metadata.') }
  }
  async availability(): Promise<{ start: string; end: string }> {
    const result = await this.json('metadata.get_dataset_range', { dataset: IDENTITY.dataset })
    const range = isRecord(result) && isRecord(result.schema) ? result.schema[IDENTITY.schema] : null
    if (!isRecord(range) || typeof range.start !== 'string' || typeof range.end !== 'string' ||
      !Number.isFinite(Date.parse(range.start)) || !Number.isFinite(Date.parse(range.end)) || Date.parse(range.start) >= Date.parse(range.end)) return invalid('Missing valid ohlcv-1m availability.')
    return { start: range.start, end: range.end }
  }
  async contracts(from: string, to: string): Promise<ContractInterval[]> {
    const base = { dataset: IDENTITY.dataset, start_date: from, end_date: to }
    const continuous = await this.json('symbology.resolve', { ...base, symbols: IDENTITY.continuousSymbol, stype_in: 'continuous', stype_out: 'instrument_id' }, true)
    const ids = intervals(continuous, IDENTITY.continuousSymbol, from, to)
    const contracts: ContractInterval[] = []
    for (const id of ids) {
      if (!/^[1-9]\d*$/.test(id.symbol) || !Number.isSafeInteger(Number(id.symbol))) return invalid('Invalid resolved instrument ID.')
      const raw = await this.json('symbology.resolve', { ...base, start_date: id.from, end_date: id.to, symbols: id.symbol, stype_in: 'instrument_id', stype_out: 'raw_symbol' }, true)
      for (const part of intervals(raw, id.symbol, id.from, id.to)) {
        if (!/^6E[FGHJKMNQUVXZ]\d{1,2}$/.test(part.symbol)) return invalid('Resolved instrument is not an outright CME Euro FX futures contract.')
        contracts.push({ from: part.from, to: part.to, instrumentId: Number(id.symbol), rawSymbol: part.symbol })
      }
    }
    return contracts
  }
  private params(from: string, to: string) { return { dataset: IDENTITY.dataset, symbols: IDENTITY.continuousSymbol, schema: IDENTITY.schema, stype_in: 'continuous', start: from, end: to } }
  async cost(from: string, to: string): Promise<number> {
    const result = await this.json('metadata.get_cost', this.params(from, to))
    if (typeof result !== 'number' || !Number.isFinite(result) || result < 0) return invalid('The exact-range cost could not be established.')
    return result
  }
  async download(from: string, to: string, contracts: ContractInterval[]) {
    const started = performance.now()
    const text = await this.request('timeseries.get_range', { ...this.params(from, to), stype_out: 'instrument_id', encoding: 'json', compression: 'none', pretty_px: 'true', pretty_ts: 'true', map_symbols: 'false' }, true, 96 * 1024 * 1024)
    const history = decodeJsonLines(text, from, to, contracts)
    return { history, metrics: { downloadBytes: Buffer.byteLength(text), durationMs: performance.now() - started, candles: history.candles.length } }
  }
}
