import { useEffect, useMemo, useState } from 'react'
import { nextCandleIndex, previousCandleIndex } from './candleNavigation'
import { rolloverIndex, type Candle, type Timeframe } from './history'
import type { ReplayCheckpoint } from './sessionTypes'

export const REPLAY_INTERVAL_MS = 250

interface Session {
  source: readonly Candle[] | null
  index: number | null
  playing: boolean
  reviewIndex: number | null
  epoch: number
  startIndex: number
  speed: 1 | 10 | 100
}

// One clock for the loaded M1 dataset, independent of panes and timeframes.
export function useReplay(source: readonly Candle[] | null, initialIndex = 0, restored?: { replay: ReplayCheckpoint; epoch: number } | null) {
  const [session, setSession] = useState<Session>(() => ({ source, index: restored?.replay.index ?? null, playing: false, reviewIndex: null, epoch: restored?.epoch ?? 0, startIndex: restored?.replay.startIndex ?? initialIndex, speed: restored?.replay.speed ?? 1 }))
  const current = session.source === source ? session
    : { source, index: restored?.replay.index ?? null, playing: false, reviewIndex: null, epoch: restored?.epoch ?? session.epoch + 1, startIndex: restored?.replay.startIndex ?? initialIndex, speed: restored?.replay.speed ?? session.speed }
  // Reset before children render a new dataset, rather than after a paint.
  if (current !== session) setSession(current)

  const total = source?.length ?? 0
  const active = current.index !== null
  const boundaryStart = active ? current.startIndex : initialIndex
  const boundary = useMemo(() => source ? rolloverIndex(source, boundaryStart) : total, [source, boundaryStart, total])
  const last = Math.min(total, boundary) - 1
  const blocked = active && current.index === last && boundary < total
  const complete = active && current.index === total - 1
  const canAdvance = active && !complete && !blocked
  const speed = current.speed
  const setSpeed = (speed: 1 | 10 | 100) => setSession((previous) => ({ ...previous, speed }))
  const reviewing = active && current.reviewIndex !== null
  const displayCount = reviewing ? current.reviewIndex! + 1 : active ? current.index! + 1 : total
  const count = active ? current.index! + 1 : total

  useEffect(() => {
    if (!current.playing) return
    const timer = setInterval(() => {
      setSession((previous) => {
        if (previous.source !== source || !previous.playing || previous.index === null) return previous
        const index = Math.min(previous.index + speed, last)
        return { ...previous, index, playing: index < last }
      })
    }, REPLAY_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [source, total, current.playing, speed, last])

  function restart() {
    const startIndex = active ? current.startIndex : initialIndex
    if (!total || startIndex >= total) return
    setSession((previous) => ({ source, index: startIndex, startIndex, playing: false, reviewIndex: null, epoch: previous.epoch + 1, speed: previous.speed }))
  }

  return {
    // Lazy compatibility view: production charts consume source/count directly.
    get visible() { return source ? (active ? source.slice(0, count) : source) : [] },
    reviewing, displayCount,
    reviewTimestamp: reviewing ? source![current.reviewIndex!].timestamp : null,
    returnToCurrent: () => setSession(previous => ({ ...previous, reviewIndex: null })),
    navigate: (direction: 'backward' | 'forward', timeframe: Timeframe, first = 0): boolean => {
      if (!active || current.playing || !source) return false
      const at = current.reviewIndex ?? current.index!
      const target = direction === 'backward' ? previousCandleIndex(source, at, timeframe, first)
        : nextCandleIndex(source, at, timeframe, reviewing ? current.index! : last)
      if (target === at || direction === 'forward' && !reviewing && !canAdvance) return false
      // One synchronous state transition per rendered cursor. Duplicate events
      // cannot enqueue overlapping advances or race the playback clock.
      setSession(previous => {
        if (previous !== current || previous.playing) return previous
        if (direction === 'backward') return { ...previous, reviewIndex: target }
        return reviewing ? { ...previous, reviewIndex: target >= current.index! ? null : target }
          : { ...previous, index: target }
      })
      return true
    },
    count, source, blocked, startIndex: current.startIndex, speed, setSpeed, total, active, complete, playing: current.playing, epoch: current.epoch,
    revealed: active ? current.index! + 1 : 0,
    timestamp: active ? source![current.index!].timestamp : null,
    status: !active ? 'Ready' : blocked ? 'Rollover blocked' : complete ? 'Complete' : current.playing ? 'Playing' : 'Paused',
    canStart: total > 0 && initialIndex < total && !active,
    canPlay: canAdvance && !current.playing && !reviewing,
    canPause: current.playing,
    canNext: canAdvance && !current.playing && !reviewing,
    canRestart: active,
    start: restart,
    restart,
    play: () => { if (canAdvance && !reviewing) setSession((previous) => ({ ...previous, playing: true })) },
    pause: () => setSession((previous) => ({ ...previous, playing: false })),
    next: () => {
      if (!canAdvance || current.playing || reviewing) return
      setSession((previous) => ({ ...previous, index: Math.min(previous.index! + 1, last) }))
    },
  }
}
