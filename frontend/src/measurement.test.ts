import { expect, it } from 'vitest'
import type { UTCTimestamp } from 'lightweight-charts'
import { compactElapsed, measurementMetrics, nearestMeasurementAnchor, type MeasurementAnchor } from './measurement'
import { ReplayBars } from './replayBars'

const anchor = (index: number, time: number, price = 1.1): MeasurementAnchor => ({ index, time: time as UTCTimestamp, price })
it.each([[1.10015, '+1.5 pips'], [1.09697, '-30.3 pips'], [1.1, '0.0 pips'], [1.100004, '0.0 pips'], [1.099996, '0.0 pips']])('formats signed movement at full precision: %s', (price, label) => {
 const metrics = measurementMetrics({ start: anchor(0, 0), end: anchor(1, 60, price) }, .0001)
 expect(metrics.pips).toBe((price - 1.1) / .0001); expect(metrics.pipLabel).toBe(label)
})
it('uses instrument pip size rather than a futures minimum tick', () => {
 expect(measurementMetrics({ start: anchor(0, 0), end: anchor(0, 0, 1.10005) }, .0001).pipLabel).toBe('+0.5 pips')
 expect(measurementMetrics({ start: anchor(0, 0, 150), end: anchor(0, 0, 150.015) }, .01).pipLabel).toBe('+1.5 pips')
})
it.each([[0, '0m'], [45*60,'45m'], [195*60,'3h 15m'], [54*3600,'2d 6h'], [287*3600,'11d 23h'], [-195*60,'3h 15m']])('formats elapsed %s', (seconds, label) => expect(compactElapsed(seconds)).toBe(label))
it('counts real displayed bars across weekends and missing candles, in both directions', () => {
 const times = ['2024-01-05T23:00Z','2024-01-08T00:00Z','2024-01-08T02:00Z'].map(time => ({ time: Date.parse(time)/1000 as UTCTimestamp }))
 const snap = (logical: number, price = 1.1) => nearestMeasurementAnchor(times, logical, price, time => times.findIndex(c => c.time === time))!
 const a = snap(.1), b = snap(1.9, 1.09697)
 expect(measurementMetrics({ start: a, end: b }, .0001).spanLabel).toBe('2 bars · 2d 3h')
 expect(measurementMetrics({ start: b, end: a }, .0001)).toMatchObject({ pipLabel: '+30.3 pips', spanLabel: '2 bars · 2d 3h' })
 expect(measurementMetrics({ start: a, end: snap(.4) }, .0001).spanLabel).toBe('0 bars · 0m')
 // Future/projected slots and left whitespace snap only to revealed real bars.
 expect(snap(100).time).toBe(times[2].time); expect(snap(-100).time).toBe(times[0].time)
 expect(nearestMeasurementAnchor([], 1, 1, () => null)).toBeNull()
 expect(nearestMeasurementAnchor(times, null, 1, () => null)).toBeNull()
 expect(nearestMeasurementAnchor(times, 1, NaN, () => null)).toBeNull()
 // Chart logical positions can contain slots from other series between real candles.
 expect(nearestMeasurementAnchor(times, 8, 1, time => times.findIndex(c => c.time === time)*10)?.index).toBe(1)
})
it('anchors to revealed timeframe candles, never unrevealed M1 observations', () => {
 const source = Array.from({ length: 180 }, (_, i) => ({ timestamp: Date.UTC(2024,0,1)+i*60000, open: 1, high: 2, low: 0, close: 1 }))
 const bars = new ReplayBars('H1'); bars.advance(source, 70)
 expect(bars.candles).toHaveLength(2)
 expect(nearestMeasurementAnchor(bars.candles, 900, 1, time => bars.candles.findIndex(c => c.time === time))?.index).toBe(1)
 expect(bars.candles.at(-1)?.time).toBe(source[60].timestamp/1000)
})
