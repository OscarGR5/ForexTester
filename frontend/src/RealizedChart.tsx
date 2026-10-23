import { memo, useLayoutEffect, useRef, useState } from 'react'
import { formatTradingNumber as number, tradingTime } from './trading'
import type { AnalyticsScope, realizedPerformance } from './analytics'

export const RealizedChart = memo(function RealizedChart({ performance, scope = 'positions' }: { performance: ReturnType<typeof realizedPerformance>; scope?: AnalyticsScope }) {
  const container = useRef<HTMLElement>(null)
  const [width, setWidth] = useState(960)
  useLayoutEffect(() => {
    if (!container.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.floor(entry.contentRect.width))))
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [])
  const scopeLabel = scope === 'setups' ? 'completed-setup' : 'closed-position'
  const { points } = performance
  const height = 260, drawdownHeight = 160, left = 86, right = 20, top = 24, bottom = 40
  const net = points.map((point) => point.cumulativeNetPnlUsd)
  const min = Math.min(0, ...net), max = Math.max(0, ...net)
  const span = max - min || 1
  const x = (index: number) => left + index / Math.max(1, points.length - 1) * (width - left - right)
  const y = (value: number) => top + (max - value) / span * (height - top - bottom)
  const maxDd = performance.maxDrawdownUsd || 1
  const ddY = (value: number) => top + value / maxDd * (drawdownHeight - top - bottom)
  return <section ref={container} className="realized-performance" aria-label="Realized performance">
    <h3>Realized performance · {scope === 'setups' ? 'completed setups' : 'closed positions'}</h3>
    <p className="journal-help">{scope === 'setups' ? 'Completed-setup cumulative net results. Combined net PnL is attributed only at the final position exit; partial setups are excluded.' : 'Closed-position cumulative net results. Each exit is a separate event, including partial setups and simultaneous exits.'}</p>
    {points.length === 1 ? <p className="journal-empty">No {scope === 'setups' ? 'completed setups' : 'closed positions'} yet. The curve starts at $0.</p> : <>
      <svg className="realized-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Cumulative net realized PnL in USD by closure event">
        <line className="chart-baseline" x1={left} y1={y(0)} x2={width - right} y2={y(0)} />
        <text x={left - 10} y={top + 5} textAnchor="end">${number(max, 2)}</text>
        <text x={left - 10} y={height - bottom + 5} textAnchor="end">${number(min, 2)}</text>
        <polyline className="net-curve" points={points.map((point, index) => `${x(index)},${y(point.cumulativeNetPnlUsd)}`).join(' ')} />
        {points.map((point, index) => <circle className="net-point" key={point.positionId ?? 'start'} cx={x(index)} cy={y(point.cumulativeNetPnlUsd)} r="3">
          <title>{point.timestamp === null ? 'Start' : `${tradingTime(point.timestamp)} · ${scope === 'setups' ? 'Setup' : 'Position'} ${point.positionId}`} · ${number(point.cumulativeNetPnlUsd, 2)} net cumulative</title>
        </circle>)}
        <text x={left} y={height - 10}>Start</text><text x={width - right} y={height - 10} textAnchor="end">Closure {points.length - 1}</text>
      </svg>
      <h4>Realized drawdown · USD below high-water mark</h4>
      <svg className="realized-chart drawdown-chart" viewBox={`0 0 ${width} ${drawdownHeight}`} role="img" aria-label="Realized drawdown in USD by closure event">
        <line className="chart-baseline" x1={left} y1={top} x2={width - right} y2={top} />
        <text x={left - 10} y={top + 5} textAnchor="end">$0</text>
        <text x={left - 10} y={drawdownHeight - bottom + 5} textAnchor="end">${number(performance.maxDrawdownUsd, 2)}</text>
        <polyline className="drawdown-curve" points={points.map((point, index) => `${x(index)},${ddY(point.drawdownUsd)}`).join(' ')} />
        <text x={left} y={drawdownHeight - 10}>Start</text><text x={width - right} y={drawdownHeight - 10} textAnchor="end">Closure {points.length - 1}</text>
      </svg>
    </>}
    <p className="drawdown-summary">Maximum {scopeLabel} {scope === 'positions' ? 'realized ' : ''}drawdown: ${number(performance.maxDrawdownUsd, 2)} USD · {performance.maxDrawdownPercent === null ? 'Percentage unavailable' : `${number(performance.maxDrawdownPercent, 2)}%`}</p>
    {performance.nonpositiveBalance && <p className="coverage-warning">Reference plus net results reached zero or below. Percentage drawdown is unavailable; USD drawdown remains reported.</p>}
    <p className="journal-help">This analytical attribution curve uses the same scope as the KPIs. It is not account cash flow. Drawdown uses the fixed reference balance plus attributed net results. Open-position marks and entry fees appear in account equity below.</p>
    {points.length > 1 && <details><summary>Inspect realized events ({points.length - 1})</summary>
      <div className="journal-table-scroll" tabIndex={0} role="region" aria-label="Realized events table"><table>
        <caption>Realized observations in chronological completion order</caption>
        <thead><tr>{['Event', 'Setup / position', 'Exit UTC', 'Cumulative net USD', 'Reference + net results USD', 'High-water mark USD', 'Drawdown USD', 'Drawdown %'].map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{points.map((point, index) => <tr key={point.positionId ?? 'start'}><td>{index}</td><td>{point.positionId ?? 'Start'}</td>
          <td>{point.timestamp === null ? 'Session baseline' : tradingTime(point.timestamp)}</td><td>{number(point.cumulativeNetPnlUsd, 2)}</td>
          <td>{number(point.balanceUsd, 2)}</td><td>{number(point.highWaterMarkUsd, 2)}</td><td>{number(point.drawdownUsd, 2)}</td>
          <td>{point.drawdownPercent === null ? 'Unavailable' : number(point.drawdownPercent, 2)}</td></tr>)}</tbody>
      </table></div>
    </details>}
  </section>
})
