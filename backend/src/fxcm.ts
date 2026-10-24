import { createHash, randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { lstat, readFile, rename, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { providerCachePaths } from './projectPaths.js'
import type { Candle, HistoryResponse } from './history.js'
import { NORMALIZATION_VERSION, type ArchiveSource } from '../../frontend/src/history.js'

const DAY = 86_400_000, WEEK = 7 * DAY
const MAX_COMPRESSED = 2 * 1024 * 1024, MAX_DECOMPRESSED = 8 * 1024 * 1024
const HEADER = 'DateTime,BidOpen,BidHigh,BidLow,BidClose,AskOpen,AskHigh,AskLow,AskClose'
const BASE = 'https://candledata.fxcorporate.com/m1/EURUSD/'
export class FxcmError extends Error {
  constructor(readonly code: 'FXCM_MISSING' | 'FXCM_UNPUBLISHED' | 'FXCM_INVALID' | 'FXCM_NETWORK', message: string) { super(message) }
}
const invalid = () => new FxcmError('FXCM_INVALID', 'FXCM returned an invalid archive. No historical dataset was installed.')
const sunday = (ms: number) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - d.getUTCDay()) }

// Filename hints only. Accept a candidate solely when its actual observations
// belong to the requested Sunday-to-Sunday UTC trading week. No ISO mapping is assumed.
export function archiveCandidates(start: number): string[] {
  const monday = new Date(start + DAY), thursday = new Date(start + 4 * DAY)
  const isoYear = thursday.getUTCFullYear()
  const jan4 = Date.UTC(isoYear, 0, 4)
  const firstMonday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY
  const week = Math.round((monday.getTime() - firstMonday) / WEEK) + 1
  const result: string[] = []
  const add = (year: number, w: number) => { if (w >= 1 && w <= 53) result.push(`${year}/${w}.csv.gz`) }
  for (const delta of [0, -1, 1, -2, 2]) add(isoYear, week + delta)
  if (week <= 2) { add(isoYear - 1, 53); add(isoYear - 1, 52) }
  if (week >= 51) { add(isoYear + 1, 1); add(isoYear + 1, 2) }
  return [...new Set(result)] // At most seven requests per trading week.
}

export function parseFxcmArchive(bytes: Uint8Array): { bid: Candle[]; ask: Candle[] } {
  if (bytes.byteLength > MAX_COMPRESSED) throw invalid()
  let csv: string
  try { csv = gunzipSync(bytes, { maxOutputLength: MAX_DECOMPRESSED }).toString('utf8') } catch { throw invalid() }
  const lines = csv.replace(/\r/g, '').trimEnd().split('\n')
  if (lines.shift() !== HEADER || !lines.length || lines.length > 7 * 1440) throw invalid()
  const bid: Candle[] = [], ask: Candle[] = []
  let previous = -1
  for (const line of lines) {
    const columns = line.split(',')
    const match = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):00\.000$/.exec(columns[0])
    if (columns.length !== 9 || !match) throw invalid()
    const [, month, day, year, hour, minute] = match
    const timestamp = Date.UTC(+year, +month - 1, +day, +hour, +minute)
    const d = new Date(timestamp)
    if (d.getUTCFullYear() !== +year || d.getUTCMonth() !== +month - 1 || d.getUTCDate() !== +day || d.getUTCHours() !== +hour || d.getUTCMinutes() !== +minute || timestamp <= previous) throw invalid()
    const prices = columns.slice(1).map(value => /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN)
    if (prices.some(p => !Number.isFinite(p) || p <= 0)) throw invalid()
    const side = (offset: number) => {
      const [open, high, low, close] = prices.slice(offset, offset + 4)
      if (low > Math.min(open, close) || high < Math.max(open, close) || low > high) throw invalid()
      return { timestamp, open, high, low, close }
    }
    if (prices.slice(0, 4).some((p, i) => p > prices[i + 4])) throw invalid()
    bid.push(side(0)); ask.push(side(4)); previous = timestamp
  }
  if (sunday(bid[0].timestamp) !== sunday(bid.at(-1)!.timestamp)) throw invalid()
  return { bid, ask }
}
interface Archive { bid: Candle[]; ask: Candle[]; source: ArchiveSource }

export class FxcmHistory {
  private pending = new Map<string, Promise<Archive | null>>()
  private memory = new Map<string, Archive>()
  private active = 0
  private waiting: (() => void)[] = []
  constructor(private download: typeof fetch = fetch, private now: () => Date = () => new Date()) {}
  private async network(file: string): Promise<Buffer | null> {
    // Bound network concurrency even when several API clients request history.
    if (this.active >= 2) await new Promise<void>(resolve => this.waiting.push(resolve))
    else this.active++
    const signal = AbortSignal.timeout(25_000)
    try {
      const response = await this.download(BASE + file, { signal, redirect: 'error' })
      if (response.status === 404) { await response.body?.cancel(); return null }
      if (!response.ok) { await response.body?.cancel(); throw new FxcmError('FXCM_NETWORK', `FXCM archive download failed (HTTP ${response.status}). Retry later.`) }
      if (Number(response.headers.get('content-length')) > MAX_COMPRESSED) { await response.body?.cancel(); throw invalid() }
      const reader = response.body?.getReader()
      if (!reader) throw invalid()
      const parts: Uint8Array[] = []; let size = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > MAX_COMPRESSED) { await reader.cancel(); throw invalid() }
          parts.push(value)
        }
      } finally { reader.releaseLock() }
      return Buffer.concat(parts)
    } catch (error) {
      if (error instanceof FxcmError) throw error
      throw new FxcmError('FXCM_NETWORK', 'FXCM could not be reached within the download limit. Check the network and retry.')
    } finally {
      const next = this.waiting.shift()
      if (next) next(); else this.active--
    }
  }
  private archive(file: string, directory: string): Promise<Archive | null> {
    const key = `${directory}/${file}`
    const cached = this.memory.get(key)
    if (cached) return Promise.resolve(cached)
    const pending = this.pending.get(key)
    if (pending) return pending
    const task = (async () => {
      const path = join(directory, `EURUSD-M1-${NORMALIZATION_VERSION}-${file.replace('/', '-')}`)
      let bytes: Buffer | null = null, retrievedAt = this.now().toISOString()
      try {
        const info = await lstat(path)
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_COMPRESSED) throw invalid()
        bytes = await readFile(path); retrievedAt = info.mtime.toISOString()
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const downloaded = !bytes
      if (!bytes) bytes = await this.network(file)
      if (!bytes) return null // Never persist a negative result or HTML error body.
      const observations = parseFxcmArchive(bytes)
      const archive: Archive = { ...observations, source: { file, sha256: createHash('sha256').update(bytes).digest('hex'),
        first: observations.bid[0].timestamp, last: observations.bid.at(-1)!.timestamp, retrievedAt } }
      if (downloaded) {
        const temporary = `${path}.${randomUUID()}.tmp`
        try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await rename(temporary, path) }
        finally { await unlink(temporary).catch(() => {}) }
      }
      this.memory.set(key, archive)
      if (this.memory.size > 24) this.memory.delete(this.memory.keys().next().value!)
      return archive
    })()
    this.pending.set(key, task)
    void task.finally(() => this.pending.delete(key)).catch(() => {})
    return task
  }
  async load(from: string, to: string): Promise<HistoryResponse> {
    const { cacheFolderPath } = await providerCachePaths(process.env, homedir(), 'fxcm')
    const fromMs = Date.parse(from), toMs = Date.parse(to)
    const bid: Candle[] = [], ask: Candle[] = [], sources: ArchiveSource[] = []
    for (let start = sunday(fromMs); start < toMs; start += WEEK) {
      let found: Archive | null = null
      for (const file of archiveCandidates(start)) {
        const candidate = await this.archive(file, cacheFolderPath)
        if (candidate && sunday(candidate.source.first) === start) { found = candidate; break }
      }
      if (!found) {
        const unpublished = this.now().getTime() < start + 8 * DAY
        throw new FxcmError(unpublished ? 'FXCM_UNPUBLISHED' : 'FXCM_MISSING',
          unpublished ? 'FXCM has not published the requested trading week yet. Weekly archives normally arrive on Mondays. Select an earlier period or retry after publication.'
            : 'No FXCM archive was found for a required trading week within the bounded filename search. Select another period or retry later. No fallback was used.')
      }
      sources.push(found.source)
      bid.push(...found.bid.filter(b => b.timestamp >= fromMs && b.timestamp < toMs))
      ask.push(...found.ask.filter(b => b.timestamp >= fromMs && b.timestamp < toMs))
    }
    return { symbol: 'EURUSD', resolution: 'M1', from, to, bid, ask,
      provenance: { version: 2, provider: 'fxcm', normalizationVersion: NORMALIZATION_VERSION, sources } }
  }
}
