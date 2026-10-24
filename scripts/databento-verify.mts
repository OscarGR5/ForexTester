// Authenticated metadata is free. Paid verification requires the explicit flags below.
// Load DATABENTO_API_KEY securely in this process's environment; never read/print it here.
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { HistoryService } from '../backend/src/history.js'
import { DatabentoClient } from '../backend/src/databento.js'
import { providerCachePaths } from '../backend/src/projectPaths.js'
import { isSinglePrice, aggregateBidCandles, TIMEFRAMES } from '../frontend/src/history.js'
import { historyFingerprint, validatedHistory } from '../frontend/src/sessionCodec.js'
import { SessionStorage } from '../backend/src/sessionStorage.js'

const paid = process.argv.includes('--download')
if (paid && !process.argv.includes('--credits-valid-and-downloads-approved')) throw Error('Explicit confirmation of usable credits and these specific downloads is required.')
const client = new DatabentoClient(), root = (await providerCachePaths()).cacheFolderPath
const approval = { verifiedAt: process.env.DATABENTO_VERIFICATION_APPROVED_AT ?? '', balanceUsd: 121.35,
  ranges: [{ from: '2024-01-09', to: '2024-01-11' }, { from: '2023-12-02', to: '2024-03-31' }] }
const service = new HistoryService(client, root, process.env, () => new Date(), paid ? approval : undefined)
const evidencePath = resolve('docs/databento/live-verification.json')
const evidence: Record<string, unknown> = { checkedAt: new Date().toISOString(), source: 'Authenticated Databento Historical API', cacheDirectory: root,
  approval: paid ? { ...approval, evidence: 'User confirmed current portal balance and credit validity for these specific downloads in the task conversation. Actual expiry date remains unknown.' } : null,
  availability: await client.availability(), samples: [], actualBilledUsd: null }
const samples: unknown[] = []
for (const [from, to, preRoll, approvedEstimate] of [['2024-01-09', '2024-01-11', 0, .00993013382], ['2024-01-01', '2024-03-31', 30, .402984544635]] as const) {
  const quote = await service.estimate(from, to, preRoll)
  const sample: Record<string, unknown> = { quote }
  samples.push(sample); evidence.samples = samples
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n')
  if (!paid) continue
  if (quote.estimatedUsd > approvedEstimate + 1e-12 || quote.reservedUsd > quote.remainingBudgetUsd || !quote.downloadAllowed) throw Error(`Verification stopped before spending: ${quote.blockedReason ?? 'Quote exceeds approved estimate'}`)
  const started = performance.now()
  const history = await service.confirm(quote.id, true)
  if (!isSinglePrice(history)) throw Error('Wrong data model')
  const gaps: { from: string; to: string; missingMinutes: number }[] = []
  let missingMinutes = 0
  for (let index = 1; index < history.candles.length; index++) {
    const previous = history.candles[index - 1], candle = history.candles[index]
    const missing = (candle.timestamp - previous.timestamp) / 60000 - 1
    if (missing > 0) { missingMinutes += missing; gaps.push({ from: new Date(previous.timestamp + 60000).toISOString(), to: new Date(candle.timestamp).toISOString(), missingMinutes: missing }) }
  }
  sample.candles = history.candles.length; sample.gapIntervals = gaps.length; sample.missingMinutesBetweenObservations = missingMinutes
  sample.gapInterpretation = 'Includes exchange closures and no-trade intervals; M1 OHLCV alone cannot classify each gap as missing feed data.'
  sample.largestGaps = gaps.sort((a,b)=>b.missingMinutes-a.missingMinutes).slice(0,10)
  sample.contracts = history.contracts; sample.loadDurationMs = performance.now() - started
  sample.downloadMetrics = JSON.parse(await readFile(join(root, 'verification-budget.json'), 'utf8')).reservations.filter((r: { id: string }) => r.id === quote.id).map((r: { metrics: unknown }) => r.metrics)
  sample.timeframeCounts = Object.fromEntries(TIMEFRAMES.map(tf => [tf, aggregateBidCandles(history.candles, tf).length]))
  sample.normalizedJsonBytes = Buffer.byteLength(JSON.stringify(history))
  if (preRoll === 30) {
    const validated = validatedHistory(history), id = await historyFingerprint(validated)
    const storage = new SessionStorage()
    await storage.putHistory(id, validated)
    sample.historyId = id
    sample.storedJsonGzipBytes = (await stat(join((await storage.status()).directory, 'history', `${id}.json.gz`))).size
    if (await historyFingerprint(await storage.getHistory(id)) !== id) throw Error('Storage round-trip mismatch')
    await storage.close()
  }
  evidence.samples = samples
  evidence.ledger = JSON.parse(await readFile(join(root, 'verification-budget.json'), 'utf8'))
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n')
}
console.log(JSON.stringify({ evidencePath, paid, samples: samples.map((sample: any) => ({ estimatedUsd: sample.quote.estimatedUsd, cached: sample.quote.cached, candles: sample.candles })) }))
