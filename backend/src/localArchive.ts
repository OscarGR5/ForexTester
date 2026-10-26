import { DuckDBInstance } from '@duckdb/node-api'
import { constants, createReadStream, createWriteStream } from 'node:fs'
import { access, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, statfs, link, unlink } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute, dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dataDirectory } from './sessionStorage.js'
import { projectRoot } from './projectPaths.js'
import { HISTORY_PREROLL_DAYS, MAX_BACKTEST_DAYS, parseHistory, type Candle, type ForexInstrument, type LocalForexHistory } from '../../frontend/src/history.js'
import { eligibleRandomRanges, rangeCoverage } from '../../frontend/src/cacheCalendar.js'
import type { CacheCalendar, CalendarDay } from '../../frontend/src/cacheCalendar.js'

import { DataError } from './historyErrors.js'
export { DataError } from './historyErrors.js'
const DAY = 86400000, HASH = /^[a-f0-9]{64}$/, SYMBOL = /^[A-Z]{6}$/
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
function dateMs(value: string) {
  const ms = Date.parse(value)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(ms) || day(ms) !== value) throw new DataError('INVALID_HISTORY_RANGE', 'Use valid UTC dates.')
  return ms
}
export interface DatasetManifest {
  version: 1; normalizationVersion: 1; datasetId: string; sourceChecksum: string
  instrument: ForexInstrument; priceBasis: 'mid'; timestampConvention: 'utc-minute-open'
  schema: 'TS:int64,O:double,H:double,L:double,C:double'; bytes: number; rows: number
  firstTimestamp: number; lastTimestamp: number; gaps: number; calendar: CacheCalendar
}
export const EURUSD: ForexInstrument = { symbol: 'EURUSD', baseCurrency: 'EUR', quoteCurrency: 'USD', pipSize: 0.0001, priceDecimals: 7, unitsPerLot: 100000 }
async function checksum(path: string) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}
async function syncDirectory(path: string) { const file = await open(path, 'r'); try { await file.sync() } finally { await file.close() } }
async function safeFile(path: string) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new DataError('SOURCE_UNSAFE', 'Historical source is not a regular file.', 503)
  return info
}

// One embedded engine, bounded native memory. No httpfs/online extension loading.
const engine = DuckDBInstance.create(':memory:', { threads: '1', memory_limit: '256MB', autoinstall_known_extensions: 'false', autoload_known_extensions: 'false' })
export async function parquetConnection() { return (await engine).connect() }

export class LocalArchive {
  readonly directory: string
  private verified = new Map<string, string>()
  constructor(directory = dataDirectory()) { this.directory = resolve(directory, 'market-data') }
  private async root() {
    // Check existing ancestors before creating anything, including symlinked roots.
    let ancestor = this.directory
    while (true) {
      try { const canonical = await realpath(ancestor), inside = relative(projectRoot, canonical)
        if (!inside || !(inside === '..' || inside.startsWith('../') || isAbsolute(inside))) throw new DataError('SOURCE_UNSAFE', 'Market data must be outside Git.', 503)
        break
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; ancestor = dirname(ancestor) }
    }
    for (const path of [this.directory, join(this.directory, 'sources'), join(this.directory, 'manifests'), join(this.directory, 'cache')]) {
      await mkdir(path, { recursive: true, mode: 0o700 })
      if ((await lstat(path)).isSymbolicLink()) throw new DataError('SOURCE_UNSAFE', 'Market-data directories cannot be symlinks.', 503)
    }
    return this.directory
  }
  private symbol(symbol: string) { if (!SYMBOL.test(symbol)) throw new DataError('INVALID_SYMBOL', 'Choose an installed currency pair.') }
  private source(root: string, manifest: DatasetManifest) { return join(root, 'sources', manifest.instrument.symbol, manifest.datasetId, 'source.parquet') }
  private async manifest(symbol: string): Promise<DatasetManifest> {
    this.symbol(symbol)
    const root = await this.root(), path = join(root, 'manifests', `${symbol}.json`)
    try {
      await safeFile(path)
      const envelope = JSON.parse(await readFile(path, 'utf8')) as { digest: string; manifest: DatasetManifest }
      const m = envelope.manifest
      if (hash(JSON.stringify(m)) !== envelope.digest || m.version !== 1 || m.normalizationVersion !== 1 ||
        !HASH.test(m.datasetId) || m.datasetId !== m.sourceChecksum || m.instrument.symbol !== symbol ||
        m.priceBasis !== 'mid' || m.timestampConvention !== 'utc-minute-open' || !Array.isArray(m.calendar.days)) throw Error()
      const source = this.source(root, m)
      for (const folder of [join(root, 'sources', symbol), dirname(source)]) if ((await lstat(folder)).isSymbolicLink()) throw Error()
      const info = await safeFile(source), signature = `${info.dev}/${info.ino}/${info.size}/${info.mtimeMs}/${info.ctimeMs}`
      if (info.size !== m.bytes) throw Error()
      if (this.verified.get(m.datasetId) !== signature) {
        if (await checksum(source) !== m.sourceChecksum) throw Error()
        this.verified.set(m.datasetId, signature)
      }
      return m
    } catch (error) {
      if (error instanceof DataError) throw error
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new DataError('SOURCE_MISSING', `Installed ${symbol} history is missing. Import the original dataset to continue.`, 404)
      throw new DataError('SOURCE_CORRUPT', `Installed ${symbol} history failed validation. Original files were kept. Restore the source from backup.`, 503)
    }
  }
  async datasets() {
    const root = await this.root(), names = await readdir(join(root, 'manifests'))
    return Promise.all(names.filter(name => /^[A-Z]{6}\.json$/.test(name)).sort().map(async name => {
      const m = await this.manifest(name.slice(0, 6))
      return { symbol: m.instrument.symbol, instrument: m.instrument, datasetId: m.datasetId, priceBasis: m.priceBasis,
        firstTimestamp: m.firstTimestamp, lastTimestamp: m.lastTimestamp, rows: m.rows,
        earliestSelectableDate: eligibleRandomRanges(m.calendar, 1)[0]?.from,
        latestEligibleDate: day(m.lastTimestamp), maximumCalendarDays: MAX_BACKTEST_DAYS, timezone: 'UTC',
        tradingEnabled: m.instrument.symbol === 'EURUSD' && m.instrument.quoteCurrency === 'USD' }
    }))
  }
  async calendar(symbol = 'EURUSD'): Promise<CacheCalendar> {
    this.symbol(symbol)
    const root = await this.root()
    try { await access(join(root, 'manifests', `${symbol}.json`)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { days: [] }; throw error }
    return (await this.manifest(symbol)).calendar
  }
  async load(symbol: string, tradingFrom: string, to: string, warmupFrom?: string): Promise<LocalForexHistory> {
    const start = dateMs(tradingFrom), end = dateMs(to), from = warmupFrom ?? day(start - HISTORY_PREROLL_DAYS * DAY), warmup = dateMs(from)
    if (warmup > start || start >= end || (end - start) / DAY > MAX_BACKTEST_DAYS || end > Date.parse(day(Date.now()))) throw new DataError('INVALID_HISTORY_RANGE', `Choose 1 to ${MAX_BACKTEST_DAYS} completed UTC replay days with history beginning on or before the start.`)
    const m = await this.manifest(symbol)
    if (symbol !== 'EURUSD' || m.instrument.quoteCurrency !== 'USD') throw new DataError('UNSUPPORTED_TRADING_CURRENCY', 'USD risk sizing is enabled only for EURUSD.', 409)
    if (warmup < Math.floor(m.firstTimestamp / DAY) * DAY || end > (Math.floor(m.lastTimestamp / DAY) + 1) * DAY) throw new DataError('RANGE_UNAVAILABLE', 'Choose dates inside the installed history, including the required indicator warm-up.', 409)
    const coverage = rangeCoverage(m.calendar, { from: tradingFrom, to }, [])
    if (coverage.replayMissing) throw new DataError('REPLAY_DATA_MISSING', `${coverage.replayMissing} replay days have missing or unverified local observations. Choose another range.`, 409)
    if (!coverage.replay) throw new DataError('REPLAY_DATA_MISSING', 'The selected replay period contains no trading observations.', 409)
    const sourcePath = this.source(await this.root(), m), before = await safeFile(sourcePath)
    const connection = await parquetConnection()
    try {
      const result = await connection.stream('SELECT TS, O, H, L, C FROM read_parquet(?) WHERE TS >= ? AND TS < ? ORDER BY TS',
        [sourcePath, BigInt(Date.parse(from) / 1000), BigInt(end / 1000)])
      const candles: Candle[] = []
      for await (const chunk of result) for (const row of chunk.getRows()) candles.push({ timestamp: Number(row[0]) * 1000, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]) })
      result.closeSync()
      const after = await safeFile(sourcePath)
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new DataError('SOURCE_CHANGED', 'Historical source changed while reading. No data was loaded.', 409)
      return parseHistory({ format: 'local-forex-v1', source: 'local-parquet', symbol, resolution: 'M1',
        datasetId: m.datasetId, sourceChecksum: m.sourceChecksum, normalizationVersion: 1, instrument: m.instrument,
        priceModel: 'single', priceBasis: m.priceBasis, executionModel: 'single-price-m1-v1', timestampConvention: m.timestampConvention,
        from, to, candles }, { from, to }) as LocalForexHistory
    } catch (error) { if (error instanceof DataError) throw error; throw new DataError('SOURCE_CORRUPT', 'The local Parquet range could not be read. Restore the original source.', 503) }
    finally { connection.closeSync() }
  }
  // CLI-only. Browser inputs can never choose a path, schema, or execution model.
  async importFile(source: string, instrument: ForexInstrument = EURUSD, beforePublish?: () => Promise<void>): Promise<DatasetManifest> {
    this.symbol(instrument.symbol)
    if (instrument.baseCurrency !== instrument.symbol.slice(0, 3) || instrument.quoteCurrency !== instrument.symbol.slice(3) ||
      !Number.isFinite(instrument.pipSize) || instrument.pipSize <= 0 || !Number.isInteger(instrument.priceDecimals) || instrument.priceDecimals < 0 || instrument.priceDecimals > 10 || instrument.unitsPerLot !== 100000) throw new DataError('INVALID_INSTRUMENT', 'Explicit, valid Forex instrument metadata is required.')
    const input = resolve(source), original = await safeFile(input)
    await access(input, constants.R_OK)
    const root = await this.root(), symbolRoot = join(root, 'sources', instrument.symbol)
    await mkdir(symbolRoot, { recursive: true, mode: 0o700 })
    if ((await lstat(symbolRoot)).isSymbolicLink()) throw new DataError('SOURCE_UNSAFE', 'Symbol directory cannot be a symlink.', 503)
    await access(symbolRoot, constants.W_OK)
    const capacity = await statfs(symbolRoot, { bigint: true })
    if (capacity.bavail * capacity.bsize < BigInt(original.size) + 64n * 1024n * 1024n) throw new DataError('INSUFFICIENT_DISK', 'Insufficient free disk space to stage and validate this dataset.', 507)
    const stage = join(symbolRoot, `.import-${randomUUID()}`)
    await mkdir(stage, { mode: 0o700 })
    const staged = join(stage, 'source.parquet')
    try {
      const digest = createHash('sha256')
      const inputFile = await open(input, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { await pipeline(inputFile.createReadStream({ autoClose: false }), new Transform({ transform(chunk, _encoding, callback) { digest.update(chunk); callback(null, chunk) } }), createWriteStream(staged, { flags: 'wx', mode: 0o600 })) }
      finally { await inputFile.close() }
      const copied = await safeFile(input)
      if (original.size !== copied.size || original.ino !== copied.ino || original.mtimeMs !== copied.mtimeMs || original.ctimeMs !== copied.ctimeMs) throw new DataError('SOURCE_CHANGED', 'Source changed during copying. Retry with a stable file.', 409)
      const checksum = digest.digest('hex'), handle = await open(staged, 'r'); try { await handle.sync() } finally { await handle.close() }
      const manifest = await this.inspect(staged, instrument, checksum, original.size)
      await beforePublish?.()
      await syncDirectory(stage)
      const destination = join(symbolRoot, checksum)
      try { await rename(stage, destination); await syncDirectory(symbolRoot) }
      catch (error) {
        if (!['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        await safeFile(join(destination, 'source.parquet'))
        if ((await lstat(destination)).isSymbolicLink() || await checksumFile(destination) !== checksum) throw new DataError('SOURCE_CONFLICT', 'A conflicting historical object exists. It was retained.', 409)
      }
      const pointer = join(root, 'manifests', `${instrument.symbol}.json`), temporary = `${pointer}.${randomUUID()}.tmp`
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify({ digest: hash(JSON.stringify(manifest)), manifest })); await file.sync() } finally { await file.close() }
      try { await link(temporary, pointer); await syncDirectory(dirname(pointer)) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const existing = await this.manifest(instrument.symbol)
        if (JSON.stringify(existing) !== JSON.stringify(manifest)) throw new DataError('DATASET_CONFLICT', 'A different dataset is already installed for this pair. No dataset was replaced.', 409)
      } finally { await unlink(temporary) }
      return await this.manifest(instrument.symbol)
    } finally { await rm(stage, { recursive: true, force: true }) }
  }
  private async inspect(path: string, instrument: ForexInstrument, checksum: string, bytes: number): Promise<DatasetManifest> {
    const connection = await parquetConnection()
    try {
      const schema = (await connection.runAndReadAll('DESCRIBE SELECT * FROM read_parquet(?)', [path])).getRows()
      if (JSON.stringify(schema.map(row => [row[0], row[1]])) !== JSON.stringify([['TS','BIGINT'],['O','DOUBLE'],['H','DOUBLE'],['L','DOUBLE'],['C','DOUBLE']])) throw new DataError('INVALID_SCHEMA', 'Expected TS BIGINT and O/H/L/C DOUBLE columns.')
      const result = await connection.stream('SELECT TS, O, H, L, C, file_row_number FROM read_parquet(?, file_row_number=true)', [path])
      let rows = 0, previous = -1, firstTimestamp = -1, gaps = 0
      const days = new Map<string, CalendarDay>()
      for await (const chunk of result) for (const row of chunk.getRows()) {
        const [ts, o, h, l, c, rowNumber] = row
        if (typeof ts !== 'bigint' || ts <= 0n || ts > BigInt(Math.floor(Date.now() / 1000)) || ts % 60n !== 0n ||
          rowNumber !== BigInt(rows) || [o,h,l,c].some(value => typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) throw new DataError('INVALID_OBSERVATION', 'Invalid timestamp, physical ordering, null, or price. No observations were repaired.')
        const timestamp = Number(ts) * 1000, open = Number(o), high = Number(h), low = Number(l), close = Number(c)
        if (timestamp <= previous || low > Math.min(open,close) || high < Math.max(open,close) || low > high) throw new DataError('INVALID_OBSERVATION', 'Duplicate, unordered, or invalid OHLC observation. No observations were repaired.')
        if (!rows) firstTimestamp = timestamp
        if (previous >= 0 && timestamp > previous + 60000) gaps++
        previous = timestamp; rows++
        const date = day(timestamp), entry = days.get(date) ?? { date, status: 'cached' as const, observations: 0, h4: [] }
        entry.observations++
        const last = entry.h4.at(-1)
        if (last && Math.floor(last.timestamp / 14400000) === Math.floor(timestamp / 14400000)) { last.high = Math.max(last.high, high); last.low = Math.min(last.low, low); last.close = close }
        else entry.h4.push({ timestamp, open, high, low, close })
        days.set(date, entry)
      }
      result.closeSync()
      if (!rows) throw new DataError('EMPTY_SOURCE', 'The dataset contains no M1 observations.')
      const calendar: CacheCalendar = { symbol: instrument.symbol, datasetId: checksum, priceBasis: 'mid', from: day(firstTimestamp), to: day(Math.floor(previous / DAY) * DAY + DAY), firstTimestamp, lastTimestamp: previous, days: [] }
      for (let time = Math.floor(firstTimestamp / DAY) * DAY; time <= previous; time += DAY) calendar.days.push(days.get(day(time)) ?? { date: day(time), status: 'gap', observations: 0, h4: [] })
      return { version: 1, normalizationVersion: 1, datasetId: checksum, sourceChecksum: checksum, instrument: { ...instrument }, priceBasis: 'mid', timestampConvention: 'utc-minute-open', schema: 'TS:int64,O:double,H:double,L:double,C:double', bytes, rows, firstTimestamp, lastTimestamp: previous, gaps, calendar }
    } finally { connection.closeSync() }
  }
}
async function checksumFile(directory: string) { return checksum(join(directory, 'source.parquet')) }
