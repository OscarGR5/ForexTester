import { LineSeries, LineStyle, type IChartApi, type ISeriesApi, type WhitespaceData, type UTCTimestamp } from 'lightweight-charts'
import { calculateIndicators, type ChartCandle, type IndicatorLine, type IndicatorSettings } from './indicators'
import { IchimokuCloudPrimitive } from './ichimokuCloud'
import { TIMEFRAME_MS, type Timeframe } from './history'

// TradingView-inspired template; colors remain provisional for visual fine-tuning.
export const INDICATOR_COLORS = {
  upper: '#ffffff', middle: '#2962ff', lower: '#ffffff',
  upper2: '#ffffff', middle2: '#2962ff', lower2: '#ffffff', k: '#2962ff', d: '#ff9800',
  tenkan: '#81d4fa', kijun: '#4caf50', spanA: '#b2b5be', spanB: '#b2b5be', chikou: '#cddc39',
}
type LineKey = keyof typeof INDICATOR_COLORS
type RenderLine = (IndicatorLine[number] | WhitespaceData<UTCTimestamp>)[]
interface ManagedLine { series: ISeriesApi<'Line'>; data: RenderLine }

export class IndicatorSeries {
  private lines = new Map<LineKey, ManagedLine>()
  private cloud: IchimokuCloudPrimitive | null = null
  constructor(private chart: IChartApi) {}

  update(candles: readonly ChartCandle[], settings: IndicatorSettings, timeframe: Timeframe, replace: boolean): number {
    const data = calculateIndicators(candles, settings, timeframe)
    const enabled: LineKey[] = [
      ...[settings.bollinger, settings.bollinger2].flatMap((group, index): LineKey[] => {
        if (!group.enabled) return []
        const keys: LineKey[] = []
        if (group.upperVisible) keys.push(index === 0 ? 'upper' : 'upper2')
        if (group.basisVisible) keys.push(index === 0 ? 'middle' : 'middle2')
        if (group.lowerVisible) keys.push(index === 0 ? 'lower' : 'lower2')
        return keys
      }),
      ...(settings.stochastic.enabled ? ['k', 'd'] as const : []),
      ...(settings.ichimoku.enabled ? ['tenkan', 'kijun', 'spanA', 'spanB', 'chikou'] as const : []),
    ]
    for (const [key, line] of this.lines) {
      if (enabled.includes(key)) continue
      if (key === 'spanA' && this.cloud) { line.series.detachPrimitive(this.cloud); this.cloud = null }
      this.chart.removeSeries(line.series)
      this.lines.delete(key)
    }
    for (const key of enabled) {
      let line = this.lines.get(key)
      if (!line) {
        const oscillator = key === 'k' || key === 'd'
        const series = this.chart.addSeries(LineSeries, {
          color: INDICATOR_COLORS[key], lineWidth: 1, title: key,
          priceLineVisible: false, lastValueVisible: false,
          priceFormat: { type: 'price', precision: oscillator ? 2 : 5, minMove: oscillator ? 0.01 : 0.00001 },
          ...(oscillator ? { autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) } : {}),
        }, oscillator ? 1 : 0)
        line = { series, data: [] }
        this.lines.set(key, line)
        if (key === 'k') {
          for (const price of [80, 40]) series.createPriceLine({ price, color: '#7d8996', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '' })
          series.priceScale().applyOptions({ scaleMargins: { top: 0.05, bottom: 0.05 } })
          this.chart.panes()[0].setStretchFactor(3)
          this.chart.panes()[1].setStretchFactor(1)
        }
        if (key === 'spanA') { this.cloud = new IchimokuCloudPrimitive(); series.attachPrimitive(this.cloud) }
      }
      let points: RenderLine = data[key]
      if (key === 'spanA' && candles.length) {
        // Every projected position needs a time-scale slot, even when that
        // component is still warming up. These are whitespace, never OHLC.
        const byTime = new Map(points.map((point) => [point.time, point]))
        const last = candles[candles.length - 1].time
        for (let offset = 1; offset <= settings.ichimoku.displacement; offset++) {
          const time = (last + offset * TIMEFRAME_MS[timeframe] / 1000) as UTCTimestamp
          if (!byTime.has(time)) byTime.set(time, { time })
        }
        points = [...byTime.values()].sort((a, b) => a.time - b.time)
      }
      this.syncLine(line, points, replace)
    }
    this.cloud?.setData(data.cloud)
    const last = candles.at(-1)?.time
    // Reserve the entire projected horizon, including before the first span is warm.
    return settings.ichimoku.enabled && last !== undefined ? settings.ichimoku.displacement : 0
  }

  private syncLine(line: ManagedLine, next: RenderLine, replace: boolean): void {
    const previous = line.data
    // A revealed gap can relocate projected timestamps. Replace then, or when
    // settings/replay/history change; ordinary partial candle ticks update tails.
    const stableTimes = next.length >= previous.length && previous.every((point, index) => point.time === next[index].time)
    if (replace || !stableTimes || previous.length === 0) line.series.setData(next)
    else for (let index = 0; index < next.length; index++) {
      const old = previous[index], point = next[index]
      const oldValue = old && 'value' in old ? old.value : undefined
      const value = 'value' in point ? point.value : undefined
      if (!old || oldValue !== value) line.series.update(point, index < previous.length - 1)
    }
    line.data = next
  }
  dispose(): void {
    const span = this.lines.get('spanA')
    if (span && this.cloud) span.series.detachPrimitive(this.cloud)
    this.cloud = null
    for (const line of this.lines.values()) this.chart.removeSeries(line.series)
    this.lines.clear()
  }
}
