// Opt-in only. The browser harness enables this before loading the application.
// Normal playback stores no samples and makes no performance.now() calls.
export interface ReplayPerformance { samples: Record<string, number[]>; counts: Record<string, number>; latest?: Record<string, number> }
declare global { var __forexReplayPerformance: ReplayPerformance | undefined }
export function performanceStart(): number | undefined {
  return globalThis.__forexReplayPerformance ? performance.now() : undefined
}
export function performanceSample(name: string, value: number): void {
  const metrics = globalThis.__forexReplayPerformance
  if (metrics) (metrics.samples[name] ??= []).push(value)
}
export function performanceEnd(name: string, start: number | undefined): void {
  if (start !== undefined) performanceSample(name, performance.now() - start)
}
export function performanceCount(name: string, count = 1): void {
  const metrics = globalThis.__forexReplayPerformance
  if (metrics) metrics.counts[name] = (metrics.counts[name] ?? 0) + count
}
export function performanceValue(name: string, value: number): void {
  const metrics = globalThis.__forexReplayPerformance
  if (metrics) (metrics.latest ??= {})[name] = value
}
