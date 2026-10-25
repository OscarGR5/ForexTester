import { TIMEFRAME_MS, type Candle, type Timeframe } from './history'

// M1 timestamps identify completed observations at their opening minute. A gap
// closes the preceding observed bucket without inventing any missing minutes.
export function nextCandleIndex(source: readonly Candle[], index: number, timeframe: Timeframe, last = source.length - 1): number {
  if (index >= last || !source[index]) return index
  const width = TIMEFRAME_MS[timeframe]
  const end = (Math.floor(source[index].timestamp / width) + 1) * width
  const complete = source[index].timestamp + 60_000 >= end || source[index + 1].timestamp >= end
  let target = complete ? index + 1 : index
  const targetEnd = (Math.floor(source[target].timestamp / width) + 1) * width
  while (target < last && source[target + 1].timestamp < targetEnd) target++
  return target
}

export function previousCandleIndex(source: readonly Candle[], index: number, timeframe: Timeframe, first = 0): number {
  const start = Math.floor(source[index].timestamp / TIMEFRAME_MS[timeframe]) * TIMEFRAME_MS[timeframe]
  let target = index - 1
  while (target >= first && source[target].timestamp >= start) target--
  return target < first ? index : target
}
