import { memo, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { netR, type Observation } from './analytics'
import type { EquityLedger, EquityPoint } from './equity'
import { EquityDisplay } from './equityDisplay'
import { monthlyPerformance, returnPercent, startingDeficit } from './resultsAnalytics'
import { decimal, percent, profitFactor, rValue, usd } from './resultsFormatting'
import { tradingTime } from './trading'

export function Help({ text }: { text: string }) {
  const id = useId(), tooltip = useRef<HTMLSpanElement>(null)
  const [position, setPosition] = useState({ left: 0, top: 0 }), [dismissed, setDismissed] = useState(false)
  const place = (element: HTMLElement) => {
    const box = element.getBoundingClientRect(), height = tooltip.current?.offsetHeight ?? 180
    setPosition({ left: Math.max(12, Math.min(window.innerWidth - 312, box.left)), top: box.bottom + height + 8 > window.innerHeight ? Math.max(8, box.top - height - 8) : box.bottom + 8 })
    setDismissed(false)
  }
  return <span className={`results-help${dismissed ? ' results-help-dismissed' : ''}`} tabIndex={0} aria-label="Calculation details" aria-describedby={id}
    onPointerEnter={event => place(event.currentTarget)} onFocus={event => place(event.currentTarget)} onKeyDown={event => { if (event.key === 'Escape') { setDismissed(true); event.stopPropagation() } }}>
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="M8 7v4M8 4.5v.5" /></svg>
    <span ref={tooltip} className="results-help-text" id={id} role="tooltip" style={position}>{text}</span>
  </span>
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null), [width, setWidth] = useState(640)
  useLayoutEffect(() => {
    if (!ref.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, Math.floor(entry.contentRect.width))))
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])
  return { ref, width }
}

// One path per series, even for a long, discontinuous M1 history.
export function timelinePath(points: readonly EquityPoint[], value: (p: EquityPoint) => number | null, x: (timestamp: number) => number, y: (value: number) => number) {
  let drawing = false
  const commands: string[] = []
  for (const point of points) {
    const v = value(point)
    if (point.clockGap || v === null || !Number.isFinite(v)) drawing = false
    if (v !== null && Number.isFinite(v)) {
      commands.push(`${drawing ? 'L' : 'M'}${x(point.timestamp).toFixed(2)},${y(v).toFixed(2)}`)
      // A dot makes isolated observations visible without bridging gaps.
      if (!drawing) commands.push('l0,0')
      drawing = true
    }
  }
  return commands.join(' ')
}

export function nearestObservation(points: readonly EquityPoint[], timestamp: number): EquityPoint | null {
  if (!points.length) return null
  let low = 0, high = points.length - 1
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (points[mid].timestamp < timestamp) low = mid + 1
    else high = mid
  }
  const next = points[low], previous = points[Math.max(0, low - 1)]
  if (next.clockGap && timestamp > previous.timestamp + 30_000 && timestamp < next.timestamp - 30_000) return null
  return Math.abs(timestamp - previous.timestamp) < Math.abs(next.timestamp - timestamp) ? previous : next
}

const Timeline = memo(function Timeline({ points, width, referenceBalance, mode, unit, hoverTime, onHover }: {
  points: readonly EquityPoint[]; width: number; referenceBalance: number; mode: 'equity' | 'drawdown'; unit: 'percent' | 'usd'
  hoverTime: number | null; onHover: (timestamp: number | null) => void
}) {
  const height = mode === 'equity' ? 254 : 208, left = 80, right = 16, top = 16, bottom = 36
  const first = points[0]?.timestamp ?? 0, last = points.at(-1)?.timestamp ?? first
  const span = last - first || 60_000
  const x = (timestamp: number) => left + (timestamp - first) / span * (width - left - right)
  const geometry = useMemo(() => {
    const value = (p: EquityPoint) => mode === 'drawdown' ? p.drawdownPercent === null ? null : -p.drawdownPercent
      : unit === 'usd' ? p.equityUsd : returnPercent(p.equityUsd, referenceBalance)
    const deficit = (p: EquityPoint) => { const d = startingDeficit(p, referenceBalance); return d === null ? null : -d }
    const baseline = mode === 'equity' && unit === 'usd' ? referenceBalance : 0
    let min = baseline, max = baseline
    for (const p of points) for (const v of mode === 'drawdown' ? [value(p), deficit(p)] : [value(p)]) {
      if (v !== null && Number.isFinite(v)) { min = Math.min(min, v); max = Math.max(max, v) }
    }
    const padding = (max - min || (unit === 'usd' && mode === 'equity' ? Math.max(1, Math.abs(referenceBalance) * .01) : 1)) * .08
    min -= padding; max += mode === 'drawdown' ? 0 : padding
    const y = (v: number) => top + (max - v) / (max - min) * (height - top - bottom)
    return { min, max, baseline, y, primary: timelinePath(points, value, x, y),
      secondary: mode === 'drawdown' ? timelinePath(points, deficit, x, y) : null, value }
  }, [points, width, referenceBalance, mode, unit])
  const point = hoverTime === null ? null : points.find(p => p.timestamp === hoverTime) ?? null
  const format = mode === 'equity' && unit === 'usd' ? usd : percent
  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) return
    event.preventDefault()
    if (event.key === 'Escape') { onHover(null); return }
    const index = point ? points.indexOf(point) : -1
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1 : Math.max(0, Math.min(points.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1)))
    onHover(points[next]?.timestamp ?? null)
  }
  if (!points.length) return <p className="results-chart-empty">No M1 equity observations recorded.</p>
  return <>
    <svg className="results-timeline" viewBox={`0 0 ${width} ${height}`} role="img" tabIndex={0}
      aria-label={mode === 'equity' ? `Account equity over UTC time in ${unit === 'usd' ? 'USD' : 'net return percent'}. Use arrow keys to inspect observations.` : 'Drawdown comparison over UTC time. Negative percentages below peak and starting balance. Use arrow keys to inspect observations.'}
      onKeyDown={onKeyDown} onFocus={() => onHover(hoverTime ?? last)} onBlur={() => onHover(null)} onPointerLeave={() => onHover(null)}
      onPointerMove={event => {
        const box = event.currentTarget.getBoundingClientRect()
        const px = (event.clientX - box.left) / box.width * width
        const timestamp = first + (px - left) / (width - left - right) * span
        onHover(px < left || px > width - right ? null : nearestObservation(points, timestamp)?.timestamp ?? null)
      }}>
      {[0, .5, 1].map(ratio => {
        const value = geometry.max - (geometry.max - geometry.min) * ratio, y = geometry.y(value)
        return <g key={ratio}><line className="results-gridline" x1={left} x2={width - right} y1={y} y2={y} /><text x={left - 10} y={y + 4} textAnchor="end">{format(value)}</text></g>
      })}
      <line className="chart-baseline" x1={left} x2={width - right} y1={geometry.y(geometry.baseline)} y2={geometry.y(geometry.baseline)} />
      <path className={mode === 'equity' ? 'results-equity-line' : 'results-peak-line'} d={geometry.primary} />
      {geometry.secondary !== null && <path className="results-start-line" d={geometry.secondary} />}
      {point && <g><line className="results-crosshair" x1={x(point.timestamp)} x2={x(point.timestamp)} y1={top} y2={height - bottom} />
        {geometry.value(point) !== null && <circle className={mode === 'equity' ? 'net-point' : 'results-peak-dot'} cx={x(point.timestamp)} cy={geometry.y(geometry.value(point)!)} r="3" />}</g>}
      <text x={left} y={height - 10}>{new Date(first).toISOString().slice(0, 10)}</text>
      <text x={width - right} y={height - 10} textAnchor="end">{new Date(last).toISOString().slice(0, 16).replace('T', ' ')} UTC</text>
    </svg>
    <div className="results-chart-readout" aria-live="polite" aria-atomic="true">
      {point ? <><time>{tradingTime(point.timestamp)}</time><span>Equity {usd(point.equityUsd)} · Return {percent(returnPercent(point.equityUsd, referenceBalance), true)} · Peak DD {percent(point.drawdownPercent)} · Below start {percent(startingDeficit(point, referenceBalance))}</span></>
        : <span>Hover or focus the chart and use arrow keys to inspect M1 observations.</span>}
    </div>
  </>
})

const SETUPS_PER_PAGE = 40
export const SetupRChart = memo(function SetupRChart({ observations }: { observations: readonly Observation[] }) {
  const { ref, width } = useWidth(), [page, setPage] = useState(0), [selected, setSelected] = useState<Observation | null>(null)
  const pages = Math.max(1, Math.ceil(observations.length / SETUPS_PER_PAGE)), currentPage = Math.min(page, pages - 1)
  const visible = useMemo(() => observations.slice(currentPage * SETUPS_PER_PAGE, (currentPage + 1) * SETUPS_PER_PAGE), [observations, currentPage])
  const height = 254, left = 52, right = 12, top = 16, bottom = 36
  let min = -1, max = 1
  // Stable scale across all pages; no completed setup is dropped from analysis.
  for (const obs of observations) { const r = netR(obs.netPnlUsd, obs.initialRiskUsd); if (r !== null) { min = Math.min(min, r); max = Math.max(max, r) } }
  const y = (r: number) => top + (max - r) / (max - min) * (height - top - bottom), step = (width - left - right) / Math.max(1, visible.length)
  const description = (item: Observation) => `Setup ${item.id} · ${tradingTime(item.exitTime)} · Net PnL ${usd(item.netPnlUsd, true)} · Original risk ${usd(item.initialRiskUsd)} · ${rValue(netR(item.netPnlUsd, item.initialRiskUsd))}`
  return <section className="results-chart-panel" aria-label="R by Setup" ref={ref}>
    <div className="results-panel-heading"><h3>R by Setup</h3><Help text="One bar per completed setup, ordered by final UTC exit then setup ID. Net R = combined net PnL / combined original executed gross risk. Zero outcomes sit on the baseline; unavailable R is marked N/A." /></div>
    {!observations.length ? <p className="results-chart-empty">No completed setups yet.</p> : <>
      <svg className="results-r-chart" role="group" aria-label="Net R per completed setup" viewBox={`0 0 ${width} ${height}`}>
        {[max, 0, min].map(r => <g key={r}><text x={left - 8} y={y(r) + 4} textAnchor="end">{decimal(r, 1)}R</text></g>)}
        <line className="chart-baseline" x1={left} x2={width - right} y1={y(0)} y2={y(0)} />
        {visible.map((item, index) => {
          const r = netR(item.netPnlUsd, item.initialRiskUsd), x = left + step * index + step * .18
          return <g key={item.id}>
            <rect className={r === null || r === 0 ? 'results-r-zero' : r > 0 ? 'results-r-positive' : 'results-r-negative'}
              x={x} y={r === null || r === 0 ? y(0) - 1 : Math.min(y(r), y(0))} width={Math.max(2, step * .64)} height={Math.max(2, Math.abs(y(r ?? 0) - y(0)))}
              tabIndex={0} role="img" aria-label={description(item)} onFocus={() => setSelected(item)} onBlur={() => setSelected(null)}
              onPointerEnter={() => setSelected(item)} onPointerLeave={() => setSelected(null)}><title>{description(item)}</title></rect>
            {(visible.length <= 12 || index % 5 === 0) && <text x={x + step * .32} y={height - 10} textAnchor="middle">{currentPage * SETUPS_PER_PAGE + index + 1}</text>}
            {r === null && <text x={x + step * .32} y={y(0) - 8} textAnchor="middle">N/A</text>}
          </g>
        })}
      </svg>
      <div className="results-chart-readout" aria-live="polite">{selected ? description(selected) : 'Hover or tab to a bar for combined setup results.'}</div>
      {pages > 1 && <div className="results-r-pagination"><button aria-label="Previous setups" disabled={currentPage === 0} onClick={() => { setPage(currentPage - 1); setSelected(null) }}>Previous</button>
        <span>Setups {currentPage * SETUPS_PER_PAGE + 1}–{Math.min(observations.length, (currentPage + 1) * SETUPS_PER_PAGE)} of {observations.length}</span>
        <button aria-label="Next setups" disabled={currentPage === pages - 1} onClick={() => { setPage(currentPage + 1); setSelected(null) }}>Next</button></div>}
    </>}
  </section>
})

export const ResultsCharts = memo(function ResultsCharts({ ledger, referenceBalance, observations, start, endpoint }: {
  ledger: EquityLedger; referenceBalance: number; observations: readonly Observation[]; start: number; endpoint: number | null
}) {
  const { ref, width } = useWidth(), [display] = useState(() => new EquityDisplay()), [unit, setUnit] = useState<'percent' | 'usd'>('percent'), [hoverTime, setHoverTime] = useState<number | null>(null)
  const points = useMemo(() => display.update(ledger, width), [ledger, width, display])
  const months = useMemo(() => monthlyPerformance(observations, referenceBalance, start, endpoint), [observations, referenceBalance, start, endpoint])
  return <div className="results-performance-grid">
    <section className="results-chart-panel results-account-chart" aria-label="Account Equity"><div ref={ref}>
      <div className="results-panel-heading"><h3>Account Equity <Help text="M1 mark-to-market equity includes incurred commissions and available unrealized PnL. Return uses fixed initial capital. Missing marks and market clock gaps break the lines. Full-resolution observations determine every drawdown KPI." /></h3>
        <div className="results-unit-toggle" role="group" aria-label="Equity chart units"><button aria-pressed={unit === 'percent'} onClick={() => setUnit('percent')}>%</button><button aria-pressed={unit === 'usd'} onClick={() => setUnit('usd')}>USD</button></div></div>
      <Timeline points={points} width={width} referenceBalance={referenceBalance} mode="equity" unit={unit} hoverTime={hoverTime} onHover={setHoverTime} />
    </div></section>
    <SetupRChart observations={observations} />
    <section className="results-chart-panel" aria-label="Drawdown Comparison">
      <div className="results-panel-heading"><h3>Drawdown Comparison</h3><Help text="From peak: deficit / previous-or-current high-water mark, initially seeded with starting capital. Below starting balance: deficit / initial capital, zero while above it. Downward values are negative. Peak percentages are unavailable at nonpositive equity." /></div>
      <div className="results-chart-legend"><span className="results-peak-legend">From peak</span><span className="results-start-legend">Below starting balance</span></div>
      <Timeline points={points} width={width} referenceBalance={referenceBalance} mode="drawdown" unit="percent" hoverTime={hoverTime} onHover={setHoverTime} />
    </section>
    <section className="results-chart-panel" aria-label="Monthly Performance">
      <div className="results-panel-heading"><h3>Monthly Performance</h3><Help text="Completed setups are attributed once, to the UTC month of their final exit. Realized return is net PnL / fixed initial capital, a noncompounded contribution, not calendar-month equity return. Only the actual replay period is shown." /></div>
      <div className="results-monthly-scroll" tabIndex={0} role="region" aria-label="Monthly realized performance table"><table className="results-table"><caption className="results-visually-hidden">Completed-setup realized return contributions by UTC completion month</caption>
        <thead><tr><th scope="col">Month (UTC)</th><th scope="col">Completed<br />Setups</th><th scope="col">Realized<br />Return %</th><th scope="col">Profit<br />Factor</th></tr></thead>
        <tbody>{months.map(month => <tr key={month.month}><th scope="row">{month.month}</th><td>{month.count}</td><td className={month.netPnlUsd === 0 ? '' : month.netPnlUsd > 0 ? 'positive' : 'negative'}>{percent(month.netReturnPercent, true)}</td><td>{profitFactor(month.profitFactor)}{month.profitFactor === Infinity && <span className="results-visually-hidden"> (profits with no net losses)</span>}</td></tr>)}</tbody>
      </table>{!months.length && <p className="journal-empty">No replay period recorded.</p>}</div>
      <p className="results-caption">Realized contribution to initial capital · noncompounded</p>
    </section>
  </div>
})
