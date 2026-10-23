import { useEffect, useMemo, useState } from 'react'
import type { Candle } from './history'

export const REPLAY_INTERVAL_MS = 250

interface Session {
  source: readonly Candle[] | null
  index: number | null
  playing: boolean
  epoch: number
}

// One clock for the loaded M1 dataset, independent of panes and timeframes.
export function useReplay(source: readonly Candle[] | null) {
  const [session, setSession] = useState<Session>({ source, index: null, playing: false, epoch: 0 })
  const current = session.source === source ? session
    : { source, index: null, playing: false, epoch: session.epoch + 1 }
  // Reset before children render a new dataset, rather than after a paint.
  if (current !== session) setSession(current)

  const total = source?.length ?? 0
  const active = current.index !== null
  const complete = active && current.index === total - 1
  const canAdvance = active && !complete
  const visible = useMemo(() => source
    ? current.index === null ? source : source.slice(0, current.index + 1)
    : [], [source, current.index])

  useEffect(() => {
    if (!current.playing) return
    const timer = setInterval(() => {
      setSession((previous) => {
        if (previous.source !== source || !previous.playing || previous.index === null) return previous
        const index = Math.min(previous.index + 1, total - 1)
        return { ...previous, index, playing: index < total - 1 }
      })
    }, REPLAY_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [source, total, current.playing])

  function restart() {
    if (!total) return
    setSession((previous) => ({ source, index: 0, playing: false, epoch: previous.epoch + 1 }))
  }

  return {
    visible, total, active, complete, playing: current.playing, epoch: current.epoch,
    revealed: active ? current.index! + 1 : 0,
    timestamp: active ? source![current.index!].timestamp : null,
    status: !active ? 'Ready' : complete ? 'Complete' : current.playing ? 'Playing' : 'Paused',
    canStart: total > 0 && !active,
    canPlay: canAdvance && !current.playing,
    canPause: current.playing,
    canNext: canAdvance && !current.playing,
    canRestart: active && (current.index! > 0 || current.playing),
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
