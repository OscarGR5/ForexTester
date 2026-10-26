import '../backend/src/environment.js'
import { LocalArchive, EURUSD } from '../backend/src/localArchive.js'
const source = process.argv[2]
if (!source) throw new Error('Usage: node --import tsx scripts/import-local-forex.mts /absolute/source.parquet [instrument-metadata.json]')
// Additional pairs require explicit metadata; their USD trading stays disabled.
const metadata = process.argv[3] ? JSON.parse(await (await import('node:fs/promises')).readFile(process.argv[3], 'utf8')) : EURUSD
const started = performance.now()
const manifest = await new LocalArchive().importFile(source, metadata)
console.log(JSON.stringify({ symbol: manifest.instrument.symbol, datasetId: manifest.datasetId, rows: manifest.rows,
  firstTimestamp: manifest.firstTimestamp, lastTimestamp: manifest.lastTimestamp,
  elapsedSeconds: (performance.now() - started) / 1000, peakRssMiB: process.resourceUsage().maxRSS / 1024 }, null, 2))
