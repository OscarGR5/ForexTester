import { useEffect, useState } from 'react'
import type { Candle } from './history'
import type { ReplayCheckpoint } from './sessionTypes'

export const REPLAY_INTERVAL_MS = 250

interface Session {
  source: readonly Candle[] | null
  index: number | null
  playing: boolean
  epoch: number
  startIndex: number
  speed: 1 | 10 | 100
}

// One clock for the loaded M1 dataset, independent of panes and timeframes.
export function useReplay(source: readonly Candle[] | null, initialIndex = 0, restored?: { replay: ReplayCheckpoint; epoch: number } | null) {
  const [session, setSession] = useState<Session>(() => ({ source, index: restored?.replay.index ?? null, playing: false, epoch: restored?.epoch ?? 0, startIndex: restored?.replay.startIndex ?? initialIndex, speed: restored?.replay.speed ?? 1 }))
  const current = session.source === source ? session
    : { source, index: restored?.replay.index ?? null, playing: false, epoch: restored?.epoch ?? session.epoch + 1, startIndex: restored?.replay.startIndex ?? initialIndex, speed: restored?.replay.speed ?? session.speed }
  // Reset before children render a new dataset, rather than after a paint.
  if (current !== session) setSession(current)

  const total = source?.length ?? 0
  const active = current.index !== null
  const complete = active && current.index === total - 1
  const canAdvance = active && !complete
  const speed = current.speed
  const setSpeed = (speed: 1 | 10 | 100) => setSession((previous) => ({ ...previous, speed }))
  const count = active ? current.index! + 1 : total

  useEffect(() => {
    if (!current.playing) return
    const timer = setInterval(() => {
      setSession((previous) => {
        if (previous.source !== source || !previous.playing || previous.index === null) return previous
        const index = Math.min(previous.index + speed, total - 1)
        return { ...previous, index, playing: index < total - 1 }
      })
    }, REPLAY_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [source, total, current.playing, speed])

  function restart() {
    const startIndex = active ? current.startIndex : initialIndex
    if (!total || startIndex >= total) return
    setSession((previous) => ({ source, index: startIndex, startIndex, playing: false, epoch: previous.epoch + 1, speed: previous.speed }))
  }

  return {
    // Lazy compatibility view: production charts consume source/count directly.
    get visible() { return source ? (active ? source.slice(0, count) : source) : [] },
    count, source, startIndex: current.startIndex, speed, setSpeed, total, active, complete, playing: current.playing, epoch: current.epoch,
    revealed: active ? current.index! + 1 : 0,
    timestamp: active ? source![current.index!].timestamp : null,
    status: !active ? 'Ready' : complete ? 'Complete' : current.playing ? 'Playing' : 'Paused',
    canStart: total > 0 && initialIndex < total && !active,
    canPlay: canAdvance && !current.playing,
    canPause: current.playing,
    canNext: canAdvance && !current.playing,
    canRestart: active,
    start: restart,
    restart,
    play: () => { if (canAdvance) setSession((previous) => ({ ...previous, playing: true })) },
    pause: () => setSession((previous) => ({ ...previous, playing: false })),
    next: () => {
      if (!canAdvance || current.playing) return
      setSession((previous) => ({ ...previous, index: Math.min(previous.index! + 1, total - 1) }))
    },
  }
}
