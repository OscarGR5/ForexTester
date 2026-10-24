import { gzipSync } from 'node:zlib'
import { expect, it } from 'vitest'
import { parseFxcmArchive } from './fxcm.js'
import { NORMALIZATION_VERSION, parseHistory, type Candle } from '../../frontend/src/history.js'
import { validatedHistory } from '../../frontend/src/sessionCodec.js'
import type { LoadedHistory } from '../../frontend/src/historyLoader.js'
const bid:Candle={timestamp:Date.UTC(2024,2,12,12,32),open:1.1,high:1.101,low:1.099,close:1.1002}
const ask:Candle={...bid,open:1.1003,high:1.1013,low:1.0993,close:1.1005}
const source=(offer:Candle):LoadedHistory=>({symbol:'EURUSD' as const,resolution:'M1' as const,from:'2024-02-11',tradingFrom:'2024-03-12',to:'2024-03-13',bid:[{...bid}],ask:[{...offer}],provenance:{version:2 as const,provider:'fxcm' as const,normalizationVersion:NORMALIZATION_VERSION}})
const archive=(offer:Candle)=>gzipSync('DateTime,BidOpen,BidHigh,BidLow,BidClose,AskOpen,AskHigh,AskLow,AskClose\n'+
 '03/12/2024 12:32:00.000,'+[bid.open,bid.high,bid.low,bid.close,offer.open,offer.high,offer.low,offer.close].join(',')+'\n')

it.each([
 ['open',1.0999],['close',1.1001],['high',1.1009],['low',1.0989],
] as const)('retains conservative %s crossing rejection in archives, responses and stored history', (field,value)=>{
 const offer={...ask,[field]:value},history=source(offer),before=JSON.stringify(history)
 // Both sides are internally valid OHLC; only the corresponding cross-side
 // component is crossed. No tick synchronization evidence warrants admitting it.
 expect(offer.low).toBeLessThanOrEqual(Math.min(offer.open,offer.close));expect(offer.high).toBeGreaterThanOrEqual(Math.max(offer.open,offer.close))
 expect(()=>parseFxcmArchive(archive(offer))).toThrow('invalid archive')
 expect(()=>parseHistory(history,{from:history.from,to:history.to})).toThrow('original bid/ask')
 expect(()=>validatedHistory(history)).toThrow('original bid/ask')
 expect(JSON.stringify(history)).toBe(before)
})
it('accepts nonsimultaneous bid-high/ask-low overlap without comparing unrelated extrema',()=>{
 expect(bid.high).toBeGreaterThan(ask.low)
 expect(parseFxcmArchive(archive(ask))).toEqual({bid:[bid],ask:[ask]})
 const history=source(ask);expect(parseHistory(history,history).bid).toEqual([bid]);expect(validatedHistory(history)).toEqual(history)
})
it('retains exact original sides and gaps, including equal bid/ask prices, in stored history',()=>{
 const history=source(bid),later={...bid,timestamp:bid.timestamp+120000}
 history.bid.push(later);history.ask.push({...later})
 const restored=validatedHistory(history)
 expect(restored).toEqual(history);expect(restored.bid.map(b=>b.timestamp)).toEqual([bid.timestamp,bid.timestamp+120000])
})
