import type { LoadedHistory } from './historyLoader.js'

// Large datasets are uploaded once. Yield between bounded JSON batches so the
// order form and replay controls remain responsive while preparing that upload.
export async function historyRequestBody(history: LoadedHistory): Promise<Blob> {
  const { bid, ask, ...metadata } = history
  const parts: BlobPart[] = [JSON.stringify(metadata).slice(0, -1)]
  for (const [name, candles] of [['bid', bid], ['ask', ask]] as const) {
    parts.push(`,"${name}":[`)
    for (let from = 0; from < candles.length; from += 2048) {
      if (from) parts.push(',')
      parts.push(JSON.stringify(candles.slice(from, from + 2048)).slice(1, -1))
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
    parts.push(']')
  }
  parts.push('}')
  return new Blob(parts, { type: 'application/json' })
}
