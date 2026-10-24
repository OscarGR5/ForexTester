import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { HistoryQuote } from './databentoHistory'
import { shiftDate } from './workflow'

export const usd = (value: number) => `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 })}`
export function cacheBreakdown(quote: HistoryQuote) {
  const total = (Date.parse(quote.to) - Date.parse(quote.from)) / 86400000
  const missing = quote.missingRanges.reduce((sum, range) => sum + (Date.parse(range.to) - Date.parse(range.from)) / 86400000, 0)
  return { cached: total - missing, missing, label: missing === 0 ? 'Fully cached' : missing === total ? 'No requested history cached' : 'Partially cached' }
}
export function PaidDownloadDialog({ quote, onCancel, onApprove }: { quote: HistoryQuote; onCancel: () => void; onApprove: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [now, setNow] = useState(Date.now)
  const [submitting, setSubmitting] = useState(false)
  const submitted = useRef(false)
  const expired = now >= Date.parse(quote.expiresAt)
  const breakdown = cacheBreakdown(quote)
  useLayoutEffect(() => {
    const dialog = ref.current!
    const previous = document.activeElement
    if (dialog.showModal) dialog.showModal()
    else dialog.setAttribute('open', '')
    headingRef.current?.focus(); dialog.scrollTop = 0
    return () => { dialog.close?.(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(timer) }, [])
  const disabled = !acknowledged || expired || !quote.downloadAllowed || submitting
  return <dialog ref={ref} className="paid-download-dialog" aria-labelledby="paid-download-title" aria-describedby="paid-download-description" onCancel={event => { event.preventDefault(); if (!submitted.current) onCancel() }}>
    <h2 ref={headingRef} tabIndex={-1} id="paid-download-title">Approve paid history download</h2>
    <p id="paid-download-description">6E / Databento · M1 trade prices · UTC</p>
    <p>After a successful download, your backtest will open automatically, paused and ready.</p>
    <dl className="download-period">
      <div><dt>Requested period</dt><dd>{quote.tradingFrom} through {shiftDate(quote.to, -1)}</dd></div>
      <div><dt>Included 30-day pre-roll</dt><dd>{quote.from} through {shiftDate(quote.tradingFrom, -1)}</dd></div>
    </dl>
    <section className="download-cache" aria-label="Cache coverage">
      <h3>{breakdown.label}</h3>
      <p><strong>{breakdown.cached}</strong> calendar dates cached · <strong>{breakdown.missing}</strong> additional dates needed</p>
      <details><summary>Missing date ranges ({quote.missingRanges.length})</summary><ul>{quote.missingRanges.map(range => <li key={range.from}>{range.from} through {shiftDate(range.to, -1)}</li>)}</ul></details>
    </section>
    <div className="download-cost" aria-label="Estimated new download cost">
      <span>Estimated new download · USD</span><strong>{usd(quote.estimatedUsd)}</strong>
      <p>Only missing dates will be downloaded.</p>
    </div>
    <dl className="download-allowance">
      <div><dt>Internal reservation (2× estimate)</dt><dd>{usd(quote.reservedUsd)}</dd></div>
      <div><dt>Remaining verification budget</dt><dd>{usd(quote.remainingBudgetUsd)}</dd></div>
      <div><dt>Quote expires</dt><dd><time dateTime={quote.expiresAt}>{new Date(quote.expiresAt).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')}</time></dd></div>
    </dl>
    <p className="download-disclosure">The reservation is an internal allowance against the $5 verification budget. It is not an actual charge or a guaranteed billing ceiling.</p>
    {quote.blockedReason && <p className="form-error" role="alert">{quote.blockedReason}</p>}
    {expired && <p className="form-error" role="alert">Quote expired. Cancel and load historical data again for a fresh estimate.</p>}
    <label className="download-acknowledgement"><input type="checkbox" checked={acknowledged} disabled={expired || submitting} onChange={event => setAcknowledged(event.target.checked)}/>I understand that actual Databento billing can differ from this estimate.</label>
    <div className="download-actions">
      <button type="button" disabled={submitting} onClick={onCancel}>Cancel — No download</button>
      <button type="button" className="approve-download" disabled={disabled} onClick={() => { if (submitted.current || disabled || Date.now() >= Date.parse(quote.expiresAt)) return; submitted.current = true; setSubmitting(true); onApprove() }}>{submitting ? 'Submitting approval…' : `Approve paid download — Estimated ${usd(quote.estimatedUsd)}`}</button>
    </div>
  </dialog>
}
