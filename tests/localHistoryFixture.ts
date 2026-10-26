import type { LocalForexHistory } from '../frontend/src/history.js'
import { fixtureHistory } from './databentoFixture.js'
export function localHistory():LocalForexHistory & {tradingFrom:string} {
 const original=fixtureHistory('2023-12-10','2024-01-11')
 return {format:'local-forex-v1',source:'local-parquet',symbol:'EURUSD',resolution:'M1',datasetId:'a'.repeat(64),sourceChecksum:'a'.repeat(64),normalizationVersion:1,
 priceModel:'single',priceBasis:'mid',executionModel:'single-price-m1-v1',timestampConvention:'utc-minute-open',instrument:{symbol:'EURUSD',baseCurrency:'EUR',quoteCurrency:'USD',pipSize:.0001,priceDecimals:7,unitsPerLot:100000},from:original.from,to:original.to,tradingFrom:'2024-01-09',
 candles:original.candles.map(({timestamp,open,high,low,close})=>({timestamp,open,high,low,close}))}
}
