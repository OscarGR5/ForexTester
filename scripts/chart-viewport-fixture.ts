import { CandlestickSeries, createChart, type UTCTimestamp } from 'lightweight-charts'
import { ChartSynchronizer } from '../frontend/src/chartSync'
import { IndicatorSeries } from '../frontend/src/indicatorSeries'
import { defaultIndicatorSettings, type ChartCandle } from '../frontend/src/indicators'

// Runs in Chromium with the real library, including projected time-scale slots.
export async function sparseViewportFixture() {
  const host = document.createElement('div')
  document.body.append(host)
  const chart = createChart(host, { width: 1000, height: 320, timeScale: { timeVisible: true, fixLeftEdge: false, fixRightEdge: false } })
  const price = chart.addSeries(CandlestickSeries), indicators = new IndicatorSeries(chart)
  const sync = new ChartSynchronizer(), unregister = sync.register(0, chart, price, [], 'H1')
  const settings = defaultIndicatorSettings(); settings.ichimoku.enabled = true
  const first = Date.parse('2024-01-03T12:00Z') / 1000
  const candles: ChartCandle[] = Array.from({ length: 65 }, (_, i) => ({
    time: (first + (i < 60 ? i : i + 48) * 3600) as UTCTimestamp,
    open: 1.1 + i * .00001, high: 1.102, low: 1.099, close: 1.101,
  }))
  const frame = () => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())))
  const measurements: unknown[] = []
  let previous = 0
  try {
    for (const count of [0, 1, 60, 61, 62, 65]) {
      const data = candles.slice(0, count)
      const replace = count <= 60, dirty = replace ? 0 : previous - 1
      sync.update(0, data, 'H1', () => {
        if (replace) price.setData(data)
        else for (const candle of data.slice(dirty)) price.update(candle)
        return indicators.update(data, settings, 'H1', replace)
      }, dirty, true)
      previous = count
      await frame()
      const range = chart.timeScale().getVisibleLogicalRange(), last = data.at(-1)
      measurements.push({ count, range, lastIndex: last ? chart.timeScale().timeToIndex(last.time) : null,
        lastX: last ? chart.timeScale().timeToCoordinate(last.time) : null, width: chart.timeScale().width(), view: sync.snapshot() })
    }
    return measurements
  } finally { unregister(); indicators.dispose(); chart.remove(); host.remove() }
}
