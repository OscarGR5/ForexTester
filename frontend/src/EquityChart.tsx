import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { type EquityLedger, type EquityPoint } from './equity'
import { formatTradingNumber as number, tradingTime } from './trading'

export function equityObservations(ledger: EquityLedger): EquityPoint[] {
  const points: EquityPoint[] = new Array(ledger.count)
  let node = ledger.tail
  for (let index = points.length - 1; node; node = node.previous) points[index--] = node.point
  return points
}

// Display only. Keep time-bucket endpoints and all financial extrema, plus both
// sides of missing observations and clock gaps. The ledger remains untouched.
export function downsampleEquity(points: readonly EquityPoint[], pixels: number): EquityPoint[] {
  if (points.length <= pixels * 4) return [...points]
  const first = points[0].timestamp, span = points.at(-1)!.timestamp - first || 1
  const selected = new Set<number>([0, points.length - 1])
  let bucket = -1, start = 0, min = 0, max = 0, dd = 0, cashMin = 0, cashMax = 0
  const flush = (end: number) => { for (const index of [start, end, min, max, dd, cashMin, cashMax]) selected.add(index) }
  for (let index = 0; index < points.length; index++) {
    const point = points[index]
    const nextBucket = Math.floor((point.timestamp - first) / span * Math.max(1, pixels / 4))
    if (nextBucket !== bucket) {
      if (index) flush(index - 1)
      bucket = nextBucket; start = min = max = dd = cashMin = cashMax = index
    }
    if (point.equityUsd !== null) {
      if (points[min].equityUsd === null || point.equityUsd < points[min].equityUsd!) min = index
      if (points[max].equityUsd === null || point.equityUsd > points[max].equityUsd!) max = index
      if ((point.drawdownUsd ?? 0) > (points[dd].drawdownUsd ?? 0)) dd = index
    }
    if (point.cashUsd < points[cashMin].cashUsd) cashMin = index
    if (point.cashUsd > points[cashMax].cashUsd) cashMax = index
    if (point.clockGap || (index && (point.equityUsd === null) !== (points[index - 1].equityUsd === null))) {
      selected.add(index); if (index) selected.add(index - 1)
    }
  }
  flush(points.length - 1)
  return [...selected].sort((a, b) => a - b).map((index) => points[index])
}

export const EquityChart = memo(function EquityChart({ ledger, referenceBalance }: { ledger: EquityLedger; referenceBalance: number }) {
  const container = useRef<HTMLElement>(null)
  const [width, setWidth] = useState(960)
  const [showCash, setShowCash] = useState(false)
  useLayoutEffect(() => {
    if (!container.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.floor(entry.contentRect.width))))
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [])
  const points = useMemo(() => downsampleEquity(equityObservations(ledger), width), [ledger, width])
  const current = ledger.tail?.point
  const money = (value: number | null | undefined) => value === null || value === undefined ? 'Unavailable' : `$${number(value, 2)}`
  let min = referenceBalance, max = referenceBalance
  for (const point of points) {
    if (point.equityUsd !== null) { min = Math.min(min, point.equityUsd); max = Math.max(max, point.equityUsd) }
    if (showCash) { min = Math.min(min, point.cashUsd); max = Math.max(max, point.cashUsd) }
  }
  const left = 86, right = 20, top = 24, bottom = 40, height = 260, ddHeight = 160
  const first = points[0]?.timestamp ?? 0, span = (points.at(-1)?.timestamp ?? first) - first || 60_000
  const x = (point: EquityPoint) => left + (point.timestamp - first) / span * (width - left - right)
  const y = (value: number) => top + (max - value) / (max - min || 1) * (height - top - bottom)
  const ddY = (value: number) => top + value / (ledger.maxDrawdownUsd || 1) * (ddHeight - top - bottom)
  function paths(key: 'equityUsd' | 'cashUsd' | 'drawdownUsd', ordinate: (value: number) => number) {
    const segments: string[] = []
    let segment: string[] = []
    for (const point of points) {
      if (point.clockGap || point[key] === null) { if (segment.length) segments.push(segment.join(' ')); segment = [] }
      if (point[key] !== null) segment.push(`${x(point)},${ordinate(point[key]!)}`)
    }
    if (segment.length) segments.push(segment.join(' '))
    return segments
  }
  return <section ref={container} className="trading-journal equity-performance" aria-label="Account equity and equity drawdown">
    <h2>Account equity and equity drawdown</h2>
    <p className="journal-help">Mark-to-market account equity · USD · State after every revealed M1 candle. Cash includes incurred execution fees; unrealized PnL uses bid close for longs and ask close for shorts. Future exit fees are excluded.</p>
    <dl className="journal-kpis">{[
      ['Current equity USD', money(current?.equityUsd)], ['Cash balance USD', money(current?.cashUsd ?? referenceBalance)],
      ['Gross unrealized PnL USD', money(current?.unrealizedUsd)], ['Maximum equity USD', money(ledger.highWaterMarkUsd)],
      ['Current equity drawdown USD', money(current?.drawdownUsd)],
      ['Current equity drawdown %', current?.drawdownPercent == null ? 'Unavailable' : `${number(current.drawdownPercent, 2)}%`],
      ['Maximum mark-to-market equity drawdown USD', money(ledger.maxDrawdownUsd)],
      ['Maximum mark-to-market equity drawdown %', ledger.maxDrawdownPercent === null ? 'Unavailable' : `${number(ledger.maxDrawdownPercent, 2)}%`],
    ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    {ledger.nonpositiveEquity && <p className="coverage-warning">Equity reached zero or below. Percentage drawdown is unavailable; USD drawdown remains recorded.</p>}
    {ledger.missingCount > 0 && <p className="coverage-warning">{ledger.missingCount} M1 equity observations unavailable because required closing-side quotes were missing. Cash remains known. Gaps are not interpolated.</p>}
    {current?.missingSides.length ? <p role="status">Current equity unavailable: missing {current.missingSides.join(' and ')} quote.</p> : null}
    {!points.length ? <p className="journal-empty">Start replay to record M1 account equity.</p> : <>
      <label className="equity-cash-toggle"><input type="checkbox" checked={showCash} onChange={(event) => setShowCash(event.target.checked)} /> Show cash balance reference</label>
      <svg className="realized-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Mark-to-market account equity in USD over UTC time">
        <text x={left - 10} y={top + 5} textAnchor="end">{money(max)}</text><text x={left - 10} y={height - bottom + 5} textAnchor="end">{money(min)}</text>
        <line className="chart-baseline" x1={left} y1={y(referenceBalance)} x2={width - right} y2={y(referenceBalance)} />
        {showCash && paths('cashUsd', y).map((path, index) => <polyline key={`cash-${index}`} className="cash-curve" points={path} />)}
        {paths('equityUsd', y).map((path, index) => <polyline key={index} className="net-curve" points={path} />)}
        {current?.equityUsd != null && <circle className="net-point" cx={x(current)} cy={y(current.equityUsd)} r="2" />}
        <text x={left} y={height - 25}>{tradingTime(first)}</text><text x={width - right} y={height - 10} textAnchor="end">{tradingTime(points.at(-1)!.timestamp)}</text>
      </svg>
      <h3>Equity drawdown · USD below high-water mark</h3>
      <svg className="realized-chart drawdown-chart" viewBox={`0 0 ${width} ${ddHeight}`} role="img" aria-label="Mark-to-market equity drawdown in USD over UTC time">
        <text x={left - 10} y={top + 5} textAnchor="end">$0</text><text x={left - 10} y={ddHeight - bottom + 5} textAnchor="end">{money(ledger.maxDrawdownUsd)}</text>
        {paths('drawdownUsd', ddY).map((path, index) => <polyline key={index} className="drawdown-curve" points={path} />)}
        <text x={left} y={ddHeight - 10}>UTC</text><text x={width - right} y={ddHeight - 10} textAnchor="end">{ledger.count} M1 observations</text>
      </svg>
    </>}
    <p className="journal-help">Equity and its drawdown are independent of statistics scope. Missing quotes and market clock gaps break chart lines. M1 OHLC snapshots cannot reconstruct tick-level or intraminute equity. Display downsampling preserves extrema; all observations determine the recorded maximum drawdown.</p>
  </section>
})
