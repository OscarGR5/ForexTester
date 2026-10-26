import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { LegacyHistoryCache, LEGACY_IDENTITY } from './history.js'
import { fixtureHistory } from '../../tests/databentoFixture.js'
let root:string
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'legacy-cache-'))})
afterEach(async()=>{await rm(root,{recursive:true,force:true})})
it('restores original cached futures candles and contract boundaries offline',async()=>{
 const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
 const history=fixtureHistory('2024-01-09','2024-01-10'),id=hash({...LEGACY_IDENTITY,from:history.from,to:history.to,contracts:history.contracts})
 await writeFile(join(root,`${id}.json`),JSON.stringify({history,digest:hash(history)}))
 await writeFile(join(root,'2024-01-09.ref.json'),JSON.stringify({id}))
 expect(await new LegacyHistoryCache(root).readCached(history.from,history.to)).toEqual(history)
 await writeFile(join(root,`${id}.json`),'{}')
 await expect(new LegacyHistoryCache(root).readCached(history.from,history.to)).rejects.toMatchObject({code:'CACHE_CORRUPT'})
})
it('requires the original cache when legacy history is missing',async()=>{
 await expect(new LegacyHistoryCache(root).readCached('2024-01-09','2024-01-10')).rejects.toMatchObject({code:'HISTORY_NOT_CACHED'})
})
