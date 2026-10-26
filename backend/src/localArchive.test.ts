import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, readdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalArchive, EURUSD } from './localArchive.js'
import { parquetFixture } from '../../tests/localForexFixture.js'
import { isLocalForex, aggregateBidCandles } from '../../frontend/src/history.js'
let root: string, source: string, archive: LocalArchive
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'forex-parquet-')); source = await parquetFixture(root); archive = new LocalArchive(join(root,'data')) })
afterEach(async () => { await rm(root, {recursive: true, force: true}) })
it('stages, validates and repeatedly registers the same immutable source without changing the original', async () => {
  const original = await readFile(source), manifest = await archive.importFile(source)
  expect(await archive.importFile(source)).toEqual(manifest)
  expect(await readFile(source)).toEqual(original)
  expect(manifest.firstTimestamp).toBe(Date.UTC(2024,0,1)); expect(manifest.gaps).toBeGreaterThan(0)
  expect((await archive.datasets())[0]).toMatchObject({symbol:'EURUSD',priceBasis:'mid',tradingEnabled:true,maximumCalendarDays:365})
  const calendar = await archive.calendar()
  expect(calendar.days.find(d=>d.date==='2024-01-06')).toMatchObject({status:'gap',observations:0,h4:[]})
  expect(calendar.days.find(d=>d.date==='2024-01-01')!.observations).toBe(1438)
})
it('loads 365 trading days with 30 additional pre-roll days and rejects 366',async()=>{
  const longSource=await parquetFixture(root,'year',undefined,396)
  await archive.importFile(longSource)
  const history=await archive.load('EURUSD','2024-01-31','2025-01-30')
  expect(history).toMatchObject({from:'2024-01-01',to:'2025-01-30'})
  expect(history.candles[0].timestamp).toBe(Date.UTC(2024,0,1))
  expect(history.candles.at(-1)!.timestamp).toBeLessThan(Date.UTC(2025,0,30))
  await expect(archive.load('EURUSD','2024-01-31','2025-01-31')).rejects.toMatchObject({code:'INVALID_HISTORY_RANGE'})
})
it('reads exact UTC observations and preserves gaps without adding futures fields or prices', async () => {
  await archive.importFile(source)
  const history = await archive.load('EURUSD','2024-02-01','2024-03-01')
  expect(isLocalForex(history)).toBe(true)
  expect(history.from).toBe('2024-01-02')
  expect(history.candles[0]).toEqual({timestamp:Date.UTC(2024,0,2),open:1.1,high:1.1004,low:1.0996,close:1.1001})
  expect('contracts' in history || 'bid' in history || 'ask' in history || 'volume' in history.candles[0]).toBe(false)
  expect(history.candles.every(c=>c.timestamp<Date.UTC(2024,2,1))).toBe(true)
  expect(aggregateBidCandles(history.candles,'H4')[0]).toMatchObject({timestamp:Date.UTC(2024,0,2),open:1.1,close:1.1001})
})
it('rejects conflicting sources without replacing the installed dataset', async () => {
  const first = await archive.importFile(source)
  const other = await parquetFixture(root,'different',`SELECT 1704067200::BIGINT TS, 1.2::DOUBLE O, 1.2::DOUBLE H, 1.2::DOUBLE L, 1.2::DOUBLE C`)
  await expect(archive.importFile(other)).rejects.toMatchObject({code:'DATASET_CONFLICT'})
  expect((await archive.datasets())[0].datasetId).toBe(first.datasetId)
})
it.each([
  ['duplicate','SELECT 1704067200::BIGINT TS, 1.1::DOUBLE O, 1.1::DOUBLE H, 1.1::DOUBLE L, 1.1::DOUBLE C FROM range(2)'],
  ['unordered','SELECT (1704067260 - i*60)::BIGINT TS, 1.1::DOUBLE O, 1.1::DOUBLE H, 1.1::DOUBLE L, 1.1::DOUBLE C FROM range(2) t(i)'],
  ['invalid-high','SELECT 1704067200::BIGINT TS, 1.1::DOUBLE O, 1.0::DOUBLE H, 1.0::DOUBLE L, 1.1::DOUBLE C'],
  ['null','SELECT 1704067200::BIGINT TS, NULL::DOUBLE O, 1.1::DOUBLE H, 1.1::DOUBLE L, 1.1::DOUBLE C'],
  ['unit','SELECT 1704067200000::BIGINT TS, 1.1::DOUBLE O, 1.1::DOUBLE H, 1.1::DOUBLE L, 1.1::DOUBLE C'],
  ['unaligned','SELECT 1704067201::BIGINT TS, 1.1::DOUBLE O, 1.1::DOUBLE H, 1.1::DOUBLE L, 1.1::DOUBLE C']
])('rejects %s observations without publishing',async(name,sql)=>{
  const file=await parquetFixture(root,name,sql)
  await expect(archive.importFile(file)).rejects.toMatchObject({code:'INVALID_OBSERVATION'})
  expect(await archive.datasets()).toEqual([])
})
it('keeps interrupted imports unpublished and repeatable',async()=>{
  await expect(archive.importFile(source,EURUSD,async()=>{throw Error('interruption')})).rejects.toThrow('interruption')
  expect(await archive.datasets()).toEqual([])
  expect(await readdir(join(archive.directory,'sources','EURUSD'))).toEqual([])
  await archive.importFile(source);expect(await archive.datasets()).toHaveLength(1)
})
it('reports missing/corrupt sources and never substitutes another dataset',async()=>{
  const m=await archive.importFile(source),managed=join(archive.directory,'sources','EURUSD',m.datasetId,'source.parquet')
  await writeFile(managed,'corrupted')
  await expect(archive.load('EURUSD','2024-02-01','2024-02-02')).rejects.toMatchObject({code:'SOURCE_CORRUPT'})
  await rm(managed)
  await expect(archive.load('EURUSD','2024-02-01','2024-02-02')).rejects.toMatchObject({code:'SOURCE_MISSING'})
})
it('rejects unsafe symbols, paths, schema, date ranges and unsupported USD conversions',async()=>{
  await expect(archive.calendar('../../etc/passwd')).rejects.toMatchObject({code:'INVALID_SYMBOL'})
  await symlink(source,join(root,'linked.parquet'))
  await expect(archive.importFile(join(root,'linked.parquet'))).rejects.toMatchObject({code:'SOURCE_UNSAFE'})
  const wrong=await parquetFixture(root,'schema','SELECT 1 TS')
  await expect(archive.importFile(wrong)).rejects.toMatchObject({code:'INVALID_SCHEMA'})
  await archive.importFile(source)
  await expect(archive.load('EURUSD','2024-02-30','2024-03-01')).rejects.toMatchObject({code:'INVALID_HISTORY_RANGE'})
  await expect(archive.load('EURUSD','2024-01-01','2024-02-01')).rejects.toMatchObject({code:'RANGE_UNAVAILABLE'})
  await expect(archive.load('EURUSD','2024-01-01','2025-01-01')).rejects.toMatchObject({code:'INVALID_HISTORY_RANGE'})
  await archive.importFile(source,{symbol:'USDJPY',baseCurrency:'USD',quoteCurrency:'JPY',pipSize:.01,priceDecimals:5,unitsPerLot:100000})
  expect((await archive.datasets()).find(d=>d.symbol==='USDJPY')?.tradingEnabled).toBe(false)
  await expect(archive.load('USDJPY','2024-02-01','2024-03-01')).rejects.toMatchObject({code:'UNSUPPORTED_TRADING_CURRENCY'})
})
