import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { diskApiFixture } from '../../tests/diskApiFixture'
import { SessionStorage } from '../../backend/src/sessionStorage'
import { DiskSessionStore } from './diskSessionStore'
import { SessionStore } from './sessionStore'
import { historyFingerprint, recordDigest, validateRecord, validatedHistory } from './sessionCodec'
import { sessionHistory, sessionSimulation } from './sessionFixtures'
import { NORMALIZATION_VERSION, type ProviderProvenance } from './history'
import { historyRequestBody } from './historyRequestBody'
const provenance: ProviderProvenance={version:2,provider:'fxcm',normalizationVersion:NORMALIZATION_VERSION}
let disk:Awaited<ReturnType<typeof diskApiFixture>>,client:DiskSessionStore,legacy:SessionStore
beforeEach(async()=>{disk=await diskApiFixture();vi.stubGlobal('fetch',disk.fetch);vi.stubGlobal('IDBKeyRange',IDBKeyRange);client=new DiskSessionStore();legacy=new SessionStore(new IDBFactory())})
afterEach(async()=>{await legacy.close();vi.unstubAllGlobals();await disk.close()})
async function fixture(provider:ProviderProvenance|undefined=provenance){
 const history={...sessionHistory(),...(provider?{provenance:provider}:{})},sim=sessionSimulation(history);sim.observe(2)
 const base={id:crypto.randomUUID(),name:'Provider dataset',createdAt:new Date().toISOString(),range:{from:history.tradingFrom,to:history.to},historyId:await historyFingerprint(history),totalCandles:history.bid.length,...(provider?{provenance:provider}:{})}
 await client.cacheHistory(base.historyId,history);const saved=await client.save(base,sim.snapshot(),null)
 return {history,sim,base,saved}
}
it('preserves the exact v1 fingerprint and binds v2 to provider, normalization and original ask observations',async()=>{
 const history=sessionHistory();expect(await historyFingerprint(history)).toBe('8ffffddbe24baab6cb285bfb51b3df93e9a50faa09cc2c4c767902fa9fd74a04')
 const fxcm={...history,provenance},duka={...history,provenance:{...provenance,provider:'dukascopy' as const}}
 const hash=await historyFingerprint(fxcm);expect(hash).not.toBe(await historyFingerprint(history));expect(hash).not.toBe(await historyFingerprint(duka))
 expect(hash).not.toBe(await historyFingerprint({...fxcm,ask:fxcm.ask.map((b,i)=>i?b:{...b,open:b.open+.00001})}))
 expect(()=>validatedHistory({...fxcm,provenance:{...provenance,normalizationVersion:'unknown'} as unknown as ProviderProvenance})).toThrow()
 const body=JSON.parse(await (await historyRequestBody(fxcm)).text());expect(validatedHistory(body).provenance).toEqual(provenance)
})
it('saves FXCM as schema 3, restarts and restores saved observations without downloading',async()=>{
 const {history,saved}=await fixture();expect(saved.schemaVersion).toBe(3);expect(saved.provenance).toEqual(provenance)
 await disk.storage.close();const restarted=new SessionStorage({directory:disk.directory})
 try{expect((await restarted.restore(saved.id)).record).toEqual(saved);expect(await restarted.getHistory(saved.historyId)).toEqual(history)}finally{await restarted.close()}
 const download=vi.fn(async()=>{throw Error('network must not run')})
 expect((await client.recover(saved.id,download)).history).toEqual(history);expect(download).not.toHaveBeenCalled()
})
it('keeps provider identity fixed after save and rejects cross-provider replacement of identical price rows',async()=>{
 const {history,base,saved,sim}=await fixture(),duka={...provenance,provider:'dukascopy' as const}
 await expect(client.call(`/history/${saved.historyId}`,'PUT',{...history,provenance:duka})).rejects.toMatchObject({code:'HISTORY_FINGERPRINT_MISMATCH'})
 await expect(client.save({...base,provenance:duka},sim.snapshot(),saved)).rejects.toThrow()
 await client.cacheHistory(await historyFingerprint({...history,provenance:duka}),{...history,provenance:duka})
 await expect(client.save({...base,historyId:await historyFingerprint({...history,provenance:duka}),provenance:duka},sim.snapshot(),saved)).rejects.toThrow('cannot change its dataset')
 expect((await client.recover(saved.id)).record.digest).toBe(saved.digest)
})
it.each([1,2])('recovers original schema-%s disk and IndexedDB records with unchanged digests and no replacement downloads',async(version)=>{
 const {sim,base}=await fixture()
 // Keep the legacy payload free of newly inferred metadata.
 const legacyHistory=sessionHistory(),historyId=await historyFingerprint(legacyHistory)
 const legacyBase={...base,id:crypto.randomUUID(),historyId};delete legacyBase.provenance
 await legacy.cacheHistory(historyId,legacyHistory)
 const record=await legacy.save(legacyBase,sim.snapshot(),null)
 record.schemaVersion=version;if(version===1)delete record.checkpoint.lifecycle
 record.digest=await recordDigest(record);await validateRecord(record)
 const factory=(legacy as unknown as {factory:IDBFactory}).factory
 const db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=factory.open('forextester-sessions');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})
 await new Promise<void>((resolve,reject)=>{const tx=db.transaction('sessions','readwrite');tx.objectStore('sessions').put(record);tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error)});db.close()
 const download=vi.fn(async()=>{throw Error('No replacement download')})
 const restored=await legacy.recover(record.id,download);expect(restored.history).toEqual(legacyHistory);expect(restored.record.digest).toBe(record.digest)
 await client.migrate(legacy,record.id,download)
 expect((await client.recover(record.id)).record).toEqual(record);expect((await legacy.get(record.id)).digest).toBe(record.digest);expect(download).not.toHaveBeenCalled()
 expect(restored.history.provenance).toBeUndefined()
})
it('pins explicit history repair to the saved provider and fingerprint',async()=>{
 const {saved,history}=await fixture(),download=vi.fn(async()=>history)
 await client.repairHistory(saved.id,download);expect(download).toHaveBeenCalledExactlyOnceWith(saved.range,'fxcm')
 const other=vi.fn(async()=>({...history,provenance:{...provenance,provider:'dukascopy' as const}}))
 await expect(client.repairHistory(saved.id,other)).rejects.toMatchObject({code:'HISTORY_FINGERPRINT_MISMATCH'})
 expect((await client.recover(saved.id)).record.digest).toBe(saved.digest)
})
it('does not infer or add metadata when reading a legacy dataset',async()=>{
 const history=sessionHistory(),sim=sessionSimulation(history),base={id:crypto.randomUUID(),name:'Original',createdAt:new Date().toISOString(),range:{from:history.tradingFrom,to:history.to},historyId:await historyFingerprint(history),totalCandles:history.bid.length}
 await client.cacheHistory(base.historyId,history);const saved=await client.save(base,sim.snapshot(),null)
 expect(saved.schemaVersion).toBe(2);expect(saved).not.toHaveProperty('provenance');expect((await client.recover(saved.id)).record).toEqual(saved)
})
it('keeps new IndexedDB provider datasets fixed as well as disk datasets',async()=>{
 const {history,base,sim}=await fixture()
 await legacy.cacheHistory(base.historyId,history);const saved=await legacy.save(base,sim.snapshot(),null)
 const download=vi.fn(async()=>{throw Error('Unexpected download')})
 expect((await legacy.recover(saved.id,download)).history.provenance).toEqual(provenance)
 const duka={...provenance,provider:'dukascopy' as const},different={...history,provenance:duka},historyId=await historyFingerprint(different)
 await legacy.cacheHistory(historyId,different)
 await expect(legacy.save({...base,historyId,provenance:duka},sim.snapshot(),saved)).rejects.toThrow('cannot change its dataset')
 expect((await legacy.get(saved.id)).digest).toBe(saved.digest);expect(download).not.toHaveBeenCalled()
})
