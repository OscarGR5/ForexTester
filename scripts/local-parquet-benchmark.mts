import '../backend/src/environment.js'
import { LocalArchive } from '../backend/src/localArchive.js'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { writeFile } from 'node:fs/promises'
const year=Number(process.argv[2])
if(year) {
 const started=performance.now(),tradingFrom=`${year}-${year===2005?'05':'04'}-01`,to=`${year}-${year===2005?'07-30':'06-30'}`
 const history=await new LocalArchive().load('EURUSD',tradingFrom,to),elapsedSeconds=(performance.now()-started)/1000
 const bytes=Buffer.alloc(history.candles.length*40)
 let offset=0
 for(const candle of history.candles)for(const key of ['timestamp','open','high','low','close'] as const){bytes.writeDoubleLE(candle[key],offset);offset+=8}
 console.log(JSON.stringify({year,days:90,preRollDays:30,tradingFrom,from:history.from,to:history.to,selectedRows:history.candles.length,elapsedSeconds,peakRssMiB:process.resourceUsage().maxRSS/1024,candleDigest:createHash('sha256').update(bytes).digest('hex'),first:history.candles[0],last:history.candles.at(-1)}))
} else {
 const results=[2005,2015,2025].map(year=>JSON.parse(execFileSync(process.execPath,['--import','tsx',fileURLToPath(import.meta.url),String(year)],{encoding:'utf8'})))
 await writeFile('docs/local-parquet-migration/node-benchmarks.json',JSON.stringify(results,null,2)+'\n')
 console.log(JSON.stringify(results,null,2))
}
