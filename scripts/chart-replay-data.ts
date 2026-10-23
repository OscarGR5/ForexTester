import type { LoadedHistory } from '../frontend/src/historyLoader'
// Continuous deterministic M1 prices with weekend closures and isolated missing minutes.
export function benchmarkHistory(days: number): LoadedHistory {
  const first = Date.UTC(2024, 0, 1), trading = first + 30 * 86400000
  const bid: LoadedHistory['bid'] = []
  for (let i = 0; i < (30 + days) * 1440; i++) {
    const timestamp = first + i * 60000, day = new Date(timestamp).getUTCDay()
    if (day === 0 || day === 6 || i % 4999 === 4998) continue
    const open = 1.1 + Math.sin(i / 73) * .001, close = open + Math.sin(i / 11) * .0001
    bid.push({ timestamp, open, high: Math.max(open, close) + .0002, low: Math.min(open, close) - .0002, close })
  }
  return { symbol: 'EURUSD', resolution: 'M1', from: '2024-01-01', tradingFrom: new Date(trading).toISOString().slice(0, 10),
    to: new Date(trading + days * 86400000).toISOString().slice(0, 10), bid,
    ask: bid.map((bar) => ({ ...bar, open: bar.open + .0002, high: bar.high + .0002, low: bar.low + .0002, close: bar.close + .0002 })) }
}
