import { ChartTimeSlots } from '../frontend/src/chartTimeSlots'
import { createChart, CandlestickSeries } from 'lightweight-charts'
import { ReplayBars } from '../frontend/src/replayBars'
import { IndicatorSeries } from '../frontend/src/indicatorSeries'
import { indicatorPreset } from '../frontend/src/indicators'
import { ChartSynchronizer } from '../frontend/src/chartSync'
import { performanceCount, performanceStart, performanceEnd } from '../frontend/src/replayPerformance'
import type { Timeframe } from '../frontend/src/history'
import { benchmarkHistory } from './chart-replay-data'
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
export async function benchmarkCharts(days: number, timeframes: Timeframe[], batch: number, late: boolean, samples = 12) {
  const history = benchmarkHistory(days), source = history.bid
  const initial = late ? source.length - samples * batch - 2 : source.findIndex((bar) => bar.timestamp >= Date.parse(history.tradingFrom)) + 1
  const bounds = (count: number) => ({ from: source[0].timestamp / 1000, to: source[count - 1].timestamp / 1000 })
  const synchronizer = new ChartSynchronizer(bounds(initial))
  const panes = timeframes.map((timeframe, id) => {
    const host = document.createElement('div'); document.body.append(host)
    const chart = createChart(host, { width: 1400, height: 260, timeScale: { timeVisible: true, secondsVisible: false, fixLeftEdge: true, fixRightEdge: true }, localization: { timeFormatter: (time) => typeof time === 'number' ? new Date(time * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : String(time) } }), price = chart.addSeries(CandlestickSeries)
    return { timeframe, id, host, chart, price, bars: new ReplayBars(timeframe), slots: new ChartTimeSlots(chart), indicators: new IndicatorSeries(chart),
      settings: indicatorPreset(timeframe), unregister: synchronizer.register(id, chart, price, [], timeframe) }
  })
  const update = (count: number, replace: boolean) => {
    for (const p of panes) {
      const dirty = p.bars.advance(source, count)
      synchronizer.update(p.id, p.bars.candles, p.timeframe, () => {
        p.slots.prepare(p.bars.candles, replace)
        const started = performanceStart()
        if (replace) { performanceCount('candles.setData'); p.price.setData(p.bars.candles) }
        else for (let i = dirty; i < p.bars.candles.length; i++) { performanceCount('candles.update'); p.price.update(p.bars.candles[i]) }
        performanceEnd('candles.series', started)
        return p.indicators.update(p.bars.candles, p.settings, p.timeframe, replace)
      }, replace ? 0 : dirty)
    }
    synchronizer.advance(bounds(count))
  }
  try {
    update(initial, true); await frame()
    globalThis.__forexReplayPerformance = { samples: {}, counts: {} }
    const work: number[] = [], frames: number[] = []
    for (let i = 1; i <= samples; i++) {
      const start = performance.now(); update(initial + i * batch, false)
      work.push(performance.now() - start); await frame(); frames.push(performance.now() - start)
    }
    return { days, timeframes, batch, late, initial, total: source.length, work, frames, metrics: globalThis.__forexReplayPerformance }
  } finally { for (const p of panes) { p.unregister(); p.indicators.dispose(); p.chart.remove(); p.host.remove() } }
}
