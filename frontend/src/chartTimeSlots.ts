import { LineSeries, type IChartApi, type ISeriesApi } from 'lightweight-charts'
import type { ChartCandle } from './indicators'
import { performanceCount, performanceEnd, performanceStart } from './replayPerformance.js'

// Install a batch's newly revealed UTC slots in one public API call. Otherwise
// each new candle makes Lightweight Charts reindex every indicator series.
// This series contains only a bounded tail of whitespace, never market prices.
export class ChartTimeSlots {
  private series: ISeriesApi<'Line'>
  private length = 0
  constructor(chart: IChartApi) {
    this.series = chart.addSeries(LineSeries, { visible: false, priceLineVisible: false, lastValueVisible: false })
  }
  prepare(candles: readonly ChartCandle[], replace: boolean): void {
    const started = performanceStart()
    if (replace) this.series.setData([])
    else if (candles.length - this.length > 1) {
      this.series.setData(candles.slice(this.length).map(({ time }) => ({ time })))
      performanceCount('timeline.batch')
    }
    this.length = candles.length
    performanceEnd('timeline.prepare', started)
  }
}
