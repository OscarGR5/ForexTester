import { expect, it } from 'vitest'
import { indicatorPreset, indicatorWarmupRequirement } from './indicatorSettings'
it.each([['M1',0],['M5',48],['M15',48],['H1',78],['H4',78]] as const)('counts the default %s completed-candle requirement', (timeframe,required)=>{
 expect(indicatorWarmupRequirement(indicatorPreset(timeframe))).toBe(required)
})
it('reports additional warm-up when editable Ichimoku settings increase the lookback',()=>{
 const settings=indicatorPreset('H4');settings.ichimoku.spanB=100
 expect(indicatorWarmupRequirement(settings)).toBe(126)
 settings.ichimoku.enabled=false;settings.bollinger.enabled=true;settings.bollinger.length=150
 expect(indicatorWarmupRequirement(settings)).toBe(150)
})
