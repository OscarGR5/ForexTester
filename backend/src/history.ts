import { createHash, randomUUID } from 'node:crypto'
import { open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { providerCachePaths } from './projectPaths.js'
import { DatabentoClient, DataError, dateMs, day, IDENTITY } from './databento.js'
import { isSinglePrice, parseHistory, type ContractInterval, type SinglePriceHistory } from '../../frontend/src/history.js'
import type { LoadedHistory } from '../../frontend/src/historyLoader.js'

export type { Candle, HistoryResponse } from '../../frontend/src/history.js'
const DAY = 86400000
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
type Range = { from: string; to: string }
interface Plan extends Range { contracts: ContractInterval[]; estimatedUsd: number }
export interface HistoryQuote extends Range {
  id: string; tradingFrom: string; cached: boolean; estimatedUsd: number; reservedUsd: number; remainingBudgetUsd: number
  downloadAllowed: boolean; blockedReason: string | null; expiresAt: string; missingRanges: Range[]
}
interface QuotePlan { quote: HistoryQuote; plans: Plan[] }
interface Reservation { id: string; estimatedUsd: number; reservedUsd: number; from: string; to: string; at: string; state: 'reserved' | 'complete'; metrics?: unknown }
export interface ScopedCreditApproval { verifiedAt: string; balanceUsd: number; ranges: Range[] }
interface Ledger { version: 1; reservations: Reservation[] }
const clipped = (contracts: ContractInterval[], from: string, to: string) => contracts.filter(c => c.from < to && c.to > from).map(c => ({ ...c, from: c.from < from ? from : c.from, to: c.to > to ? to : c.to }))

// One file lock covers all paid work, across processes. A crash leaves the lock and
// reservation for manual review: restarting must never reset a spending allowance.
export class HistoryService {
  private quotes = new Map<string, QuotePlan>()
  constructor(readonly client = new DatabentoClient(), private directory?: string, private env: NodeJS.ProcessEnv = process.env, private now = () => new Date(), private approval?: ScopedCreditApproval) {}
  private async root() { return this.directory ?? (await providerCachePaths()).cacheFolderPath }
  private validate(from: string, to: string, maxDays = 120) {
    const start = dateMs(from), end = dateMs(to)
    if (start >= end || (end - start) / DAY > maxDays || end > dateMs(day(this.now().getTime()))) throw new DataError('INVALID_HISTORY_RANGE', `Choose 1 to ${maxDays} completed UTC calendar days.`)
  }
  private async atomic(path: string, value: unknown) {
    const temp = `${path}.${randomUUID()}.tmp`, file = await open(temp, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(value)); await file.sync() } finally { await file.close() }
    await rename(temp, path)
    const folder = await open(await this.root(), 'r')
    try { await folder.sync() } finally { await folder.close() }
  }
  private async ledger(): Promise<Ledger> {
    try {
      const value = JSON.parse(await readFile(join(await this.root(), 'verification-budget.json'), 'utf8')) as Ledger
      if (value.version !== 1 || !Array.isArray(value.reservations) || value.reservations.some(r => !Number.isFinite(r.reservedUsd) || r.reservedUsd < 0 || !Number.isFinite(r.estimatedUsd) || r.estimatedUsd < 0)) throw Error()
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, reservations: [] }
      throw new DataError('BUDGET_UNREADABLE', 'The persisted spending ledger cannot be verified. Paid requests are blocked.', 503)
    }
  }
  private allowance(ledger: Ledger, reservedUsd: number, range: Range): { remaining: number; blocked: string | null } {
    const configured = this.env.DATABENTO_TEST_BUDGET_USD === undefined ? 5 : Number(this.env.DATABENTO_TEST_BUDGET_USD)
    const maximum = Number.isFinite(configured) && configured >= 0 ? Math.min(5, configured) : 0
    const spent = ledger.reservations.reduce((sum, r) => sum + r.reservedUsd, 0)
    const remaining = Math.max(0, maximum - spent)
    const scoped = this.approval?.ranges.some(r => r.from === range.from && r.to === range.to)
    const credits = scoped ? this.approval!.balanceUsd : Number(this.env.DATABENTO_CREDITS_USD)
    const verified = Date.parse(scoped ? this.approval!.verifiedAt : this.env.DATABENTO_CREDITS_VERIFIED_AT ?? '')
    const expiry = Date.parse(this.env.DATABENTO_CREDITS_EXPIRE_AT ?? '')
    const time = this.now().getTime()
    const blocked = !this.client.configured ? 'Set DATABENTO_API_KEY in the backend environment.'
      : !Number.isFinite(credits) || credits < 0 || !Number.isFinite(verified) || verified > time || time - verified > DAY
        ? 'Current usable credits are unverified. Record the portal balance and verification time in backend configuration.'
      : !scoped && (!Number.isFinite(expiry) || expiry <= time + 15 * 60000) ? 'Credit expiry is unverified or too near. Verify it before approving a paid download.'
      : reservedUsd > remaining + 1e-12 ? `The guarded estimate exceeds the remaining $${remaining.toFixed(6)} verification budget.`
      : reservedUsd + spent > credits ? 'Verified credits cannot cover the guarded cumulative estimate.' : null
    return { remaining, blocked }
  }
  private async cachedDay(from: string): Promise<SinglePriceHistory | null> {
    try {
      const root = await this.root(), ref = JSON.parse(await readFile(join(root, `${from}.ref.json`), 'utf8')) as { id: string }
      if (!/^[a-f0-9]{64}$/.test(ref.id)) throw Error()
      const envelope = JSON.parse(await readFile(join(root, `${ref.id}.json`), 'utf8')) as { history: unknown; digest: string }
      if (envelope.digest !== hash(envelope.history)) throw Error()
      const history = parseHistory(envelope.history, { from, to: day(dateMs(from) + DAY) })
      if (!isSinglePrice(history) || ref.id !== hash({ ...IDENTITY, from: history.from, to: history.to, contracts: history.contracts })) throw Error()
      return history
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new DataError('CACHE_CORRUPT', 'A Databento cache object failed validation. Original files were retained; no replacement was downloaded.', 503)
    }
  }
  private async missing(from: string, to: string): Promise<Range[]> {
    const ranges: Range[] = []
    for (let time = dateMs(from); time < dateMs(to); time += DAY) {
      const date = day(time), end = day(time + DAY)
      if (await this.cachedDay(date)) continue
      const last = ranges.at(-1)
      if (last?.to === date) last.to = end
      else ranges.push({ from: date, to: end })
    }
    return ranges
  }
  async readCached(from: string, to: string): Promise<SinglePriceHistory> {
    this.validate(from, to)
    const parts: SinglePriceHistory[] = []
    for (let time = dateMs(from); time < dateMs(to); time += DAY) {
      const part = await this.cachedDay(day(time))
      if (!part) throw new DataError('HISTORY_NOT_CACHED', 'The requested Databento history is not fully cached. Estimate and explicitly confirm a new download in Setup.', 409)
      parts.push(part)
    }
    const contracts: ContractInterval[] = []
    for (const part of parts) for (const contract of part.contracts) {
      const previous = contracts.at(-1)
      if (previous && previous.to === contract.from && previous.instrumentId === contract.instrumentId && previous.rawSymbol === contract.rawSymbol) previous.to = contract.to
      else contracts.push({ ...contract })
    }
    return parseHistory({ ...IDENTITY, from, to, contracts, candles: parts.flatMap(p => p.candles) }, { from, to }) as SinglePriceHistory
  }
  async estimate(tradingFrom: string, to: string, preRollDays: 0 | 30 = 30): Promise<HistoryQuote> {
    this.validate(tradingFrom, to, 90)
    const from = day(dateMs(tradingFrom) - preRollDays * DAY), missing = await this.missing(from, to), plans: Plan[] = []
    if (missing.length) {
      const availability = await this.client.availability()
      if (dateMs(from) < Date.parse(availability.start) || dateMs(to) > Date.parse(availability.end)) throw new DataError('HISTORY_UNAVAILABLE', 'The selected period and its full 30-day pre-roll must fall within verified Databento ohlcv-1m availability.')
      for (const range of missing) {
        const contracts = await this.client.contracts(range.from, range.to)
        const estimatedUsd = await this.client.cost(range.from, range.to)
        plans.push({ ...range, contracts, estimatedUsd })
      }
    }
    const estimatedUsd = plans.reduce((sum, p) => sum + p.estimatedUsd, 0)
    // Keep a 100% contingency. This is still not a provider-enforced billing ceiling.
    const reservedUsd = estimatedUsd * 2
    const allowance = this.allowance(await this.ledger(), reservedUsd, { from, to })
    const quote: HistoryQuote = { id: randomUUID(), from, to, tradingFrom, cached: !missing.length, estimatedUsd, reservedUsd,
      remainingBudgetUsd: allowance.remaining, downloadAllowed: !missing.length || !allowance.blocked, blockedReason: missing.length ? allowance.blocked : null,
      expiresAt: new Date(this.now().getTime() + 5 * 60000).toISOString(), missingRanges: missing }
    for (const [id, plan] of this.quotes) if (plan.quote.expiresAt <= this.now().toISOString()) this.quotes.delete(id)
    if (this.quotes.size >= 100) this.quotes.delete(this.quotes.keys().next().value!)
    this.quotes.set(quote.id, { quote, plans })
    return quote
  }
  private async persist(history: SinglePriceHistory) {
    const root = await this.root()
    for (let time = dateMs(history.from); time < dateMs(history.to); time += DAY) {
      const from = day(time), to = day(time + DAY)
      const part = parseHistory({ ...history, from, to, contracts: clipped(history.contracts, from, to),
        candles: history.candles.filter(c => c.timestamp >= time && c.timestamp < time + DAY) }, { from, to }) as SinglePriceHistory
      const old = await this.cachedDay(from)
      if (old && hash(old) !== hash(part)) throw new DataError('CACHE_CONFLICT', 'An existing validated dataset differs. Original data was retained.', 409)
      const id = hash({ ...IDENTITY, from, to, contracts: part.contracts })
      await this.atomic(join(root, `${id}.json`), { history: part, digest: hash(part) })
      await this.atomic(join(root, `${from}.ref.json`), { id })
    }
  }
  async confirm(id: string, confirmed: boolean): Promise<LoadedHistory> {
    const plan = this.quotes.get(id)
    if (!plan || plan.quote.expiresAt <= this.now().toISOString()) throw new DataError('QUOTE_EXPIRED', 'Estimate the selected period again; this quote has expired.', 409)
    if (!confirmed) throw new DataError('DOWNLOAD_CONFIRMATION_REQUIRED', 'Explicit confirmation is required for new historical downloads.')
    const root = await this.root(), lockPath = join(root, 'download.lock')
    let lock
    try { lock = await open(lockPath, 'wx', 0o600) }
    catch { throw new DataError('DOWNLOAD_BUSY', 'Another download holds the spending lock. Wait for it to finish; a lock left after a crash needs manual review.', 409) }
    try {
      const missing = await this.missing(plan.quote.from, plan.quote.to)
      if (missing.length) {
        if (!plan.quote.downloadAllowed) throw new DataError('SPENDING_BLOCKED', plan.quote.blockedReason ?? 'Paid download blocked.', 409)
        // Cache changes invalidate paid plans; re-quote exact remaining ranges rather than overpaying.
        if (JSON.stringify(missing) !== JSON.stringify(plan.quote.missingRanges)) throw new DataError('QUOTE_CHANGED', 'The cache changed. Estimate again to price only the remaining uncached dates.', 409)
        const ledger = await this.ledger()
        // Refresh free costs and mappings immediately before reserving. Any increase or mapping change requires a new approval.
        for (const item of plan.plans) {
          const cost = await this.client.cost(item.from, item.to), contracts = await this.client.contracts(item.from, item.to)
          if (cost > item.estimatedUsd || JSON.stringify(contracts) !== JSON.stringify(item.contracts)) throw new DataError('QUOTE_CHANGED', 'Cost or contract mappings changed. Request a new estimate and confirm it.', 409)
        }
        const allowance = this.allowance(ledger, plan.quote.reservedUsd, plan.quote)
        if (allowance.blocked) throw new DataError('SPENDING_BLOCKED', allowance.blocked, 409)
        const reservation: Reservation = { id, from: plan.quote.from, to: plan.quote.to, estimatedUsd: plan.quote.estimatedUsd, reservedUsd: plan.quote.reservedUsd, at: this.now().toISOString(), state: 'reserved' }
        ledger.reservations.push(reservation)
        await this.atomic(join(root, 'verification-budget.json'), ledger)
        this.quotes.delete(id) // One use, including on failure. Never retry a paid request implicitly.
        const metrics: unknown[] = []
        for (const item of plan.plans) {
          const result = await this.client.download(item.from, item.to, item.contracts)
          await this.persist(result.history)
          metrics.push(result.metrics)
        }
        reservation.state = 'complete'; reservation.metrics = metrics
        await this.atomic(join(root, 'verification-budget.json'), ledger)
      }
      return { ...await this.readCached(plan.quote.from, plan.quote.to), tradingFrom: plan.quote.tradingFrom }
    } finally { await lock.close(); await unlink(lockPath) }
  }
}
