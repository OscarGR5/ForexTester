import { performanceStart, performanceEnd, performanceCount } from './replayPerformance.js'
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
  private processed = 0
  private lastCandle: ChartCandle | undefined
  private lastSettings: IndicatorSettings | null = null
  private lastTimeframe: Timeframe | null = null
  constructor(private chart: IChartApi) {}

  update(candles: readonly ChartCandle[], settings: IndicatorSettings, timeframe: Timeframe, replace: boolean): number {
    const horizon = settings.ichimoku.enabled && candles.length ? settings.ichimoku.displacement : 0
    if (!replace && this.processed === candles.length && this.lastCandle === candles.at(-1) &&
      this.lastSettings === settings && this.lastTimeframe === timeframe) return horizon
    const dirty = replace ? 0 : Math.max(0, this.processed - 1)
    const lookback = Math.max(settings.bollinger.enabled ? settings.bollinger.length : 0,
      settings.bollinger2.enabled ? settings.bollinger2.length : 0,
      settings.stochastic.enabled ? settings.stochastic.length + settings.stochastic.smoothK + settings.stochastic.smoothD : 0,
      settings.ichimoku.enabled ? Math.max(settings.ichimoku.tenkan, settings.ichimoku.kijun, settings.ichimoku.spanB) : 0)
    const begin = Math.max(0, dirty - lookback - (settings.ichimoku.enabled ? settings.ichimoku.displacement * 2 : 0))
    const calculation = performanceStart()
    const data = calculateIndicators(candles.slice(begin), settings, timeframe)
    performanceEnd('indicators.calculate', calculation)
    const rendering = performanceStart()
    const cutoff = candles[dirty]?.time ?? 0
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
          color: INDICATOR_COLORS[key], lineWidth: ['tenkan', 'kijun', 'chikou', 'spanA', 'spanB'].includes(key) ? 2 : 1, title: key, crosshairMarkerVisible: false,
          priceLineVisible: false, lastValueVisible: false,
          priceFormat: { type: 'price', precision: oscillator ? 2 : 5, minMove: oscillator ? 0.01 : 0.00001 },
          ...(oscillator ? { autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) } : {}),
        }, oscillator ? 1 : 0)
        // Public pane ordering keeps price overlays below candle bodies and wicks.
        // All price overlays use the same five-decimal price formatter.
        if (!oscillator) series.setSeriesOrder(0)
        series.applyOptions({ title: '' })
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
      const lineCutoff = key === 'chikou' ? candles[Math.max(0, dirty - settings.ichimoku.displacement)]?.time ?? 0 : cutoff
      this.syncLine(line, points.filter((point) => point.time >= lineCutoff), replace, lineCutoff)
    }
    performanceEnd('indicators.series', rendering)
    const cloudStart = performanceStart()
    this.cloud?.updateTail(data.cloud.filter((point) => point.time >= cutoff), cutoff, replace)
    performanceEnd('cloud.update', cloudStart)
    this.processed = candles.length
    this.lastCandle = candles.at(-1); this.lastSettings = settings; this.lastTimeframe = timeframe
    // Reserve the entire projected horizon, including before the first span is warm.
    return horizon
  }

  private syncLine(line: ManagedLine, tail: RenderLine, replace: boolean, cutoff: number): void {
    const previous = line.data
    if (!replace && !previous.length && !tail.length) return
    let start = previous.length
    while (start > 0 && previous[start - 1].time >= cutoff) start--
    let stable = !replace && tail.length >= previous.length - start
    for (let index = start; stable && index < previous.length; index++) stable = previous[index].time === tail[index - start].time
    if (!stable) {
      line.data = replace ? tail : [...previous.slice(0, start), ...tail]
      performanceCount(replace ? 'indicators.replace' : 'indicators.realign')
      performanceCount('indicators.setData')
      line.series.setData(line.data)
      return
    }
    for (let index = 0; index < tail.length; index++) {
      const point = tail[index], old = previous[start + index]
      if (!old || ('value' in old ? old.value : undefined) !== ('value' in point ? point.value : undefined)) {
        performanceCount('indicators.update')
        line.series.update(point, start + index < previous.length - 1)
      }
    }
    previous.splice(start, previous.length - start, ...tail)
  }
  dispose(): void {
    const span = this.lines.get('spanA')
    if (span && this.cloud) span.series.detachPrimitive(this.cloud)
    this.cloud = null
    for (const line of this.lines.values()) this.chart.removeSeries(line.series)
    this.lines.clear()
  }
}
