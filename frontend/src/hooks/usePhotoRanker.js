import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { rankPhotos } from '../api/client'

const RANK_BATCH_SIZE = 100 // stay under backend's 200 limit with headroom

export function usePhotoRanker(loadingComplete) {
  const photos = useStore(state => state.photos)
  const order = useStore(state => state.order)
  const sourceDir = useStore(state => state.sourceDir)
  const setAuthSessionExpired = useStore(state => state.setAuthSessionExpired)

  const [scoring, setScoring] = useState(false)
  const [scoredCount, setScoredCount] = useState(0)
  const [scoreError, setScoreError] = useState(null)
  const [backendAvailable, setBackendAvailable] = useState(true)
  const [authExpired, setAuthExpired] = useState(false)
  /** Incremented when the user clicks “Begin AI scoring”; reset on new folder */
  const [scoringRunId, setScoringRunId] = useState(0)
  const [etaSeconds, setEtaSeconds] = useState(null)
  const scoringStartedAt = useRef(null)

  // Reset when the user picks a new source folder
  useEffect(() => {
    setScoringRunId(0)
    setScoredCount(0)
    setScoreError(null)
    setBackendAvailable(true)
    setAuthExpired(false)
    setAuthSessionExpired(false)
    setEtaSeconds(null)
    scoringStartedAt.current = null
  }, [sourceDir, setAuthSessionExpired])

  const beginScoring = useCallback(() => {
    if (!loadingComplete) return
    setScoreError(null)
    setBackendAvailable(true)
    setAuthExpired(false)
    setAuthSessionExpired(false)
    setScoringRunId((n) => n + 1)
  }, [loadingComplete, setAuthSessionExpired])

  useEffect(() => {
    if (scoringRunId === 0 || !loadingComplete) return

    const { order: o, photos: ph } = useStore.getState()
    const scoreable = o
      .map((id) => ph[id])
      .filter((p) => p && !p.isRaw && p.file)

    if (scoreable.length === 0) return

    let cancelled = false
    const { setIsScoring: setBusy, setScoringProgress: setProg, setAuthSessionExpired: setExpired } =
      useStore.getState()

    async function score() {
      setScoring(true)
      setBusy(true)
      setScoreError(null)
      setScoredCount(0)
      setProg(0, scoreable.length)
      setEtaSeconds(null)
      scoringStartedAt.current = Date.now()

      try {
        for (let i = 0; i < scoreable.length; i += RANK_BATCH_SIZE) {
          if (cancelled) break

          const batch = scoreable.slice(i, i + RANK_BATCH_SIZE)
          const results = await rankPhotos(batch)

          if (cancelled) break

          useStore.getState().batchUpdateScores(results)
          const done = i + batch.length
          setScoredCount(done)
          useStore.getState().setScoringProgress(done, scoreable.length)

          const started = scoringStartedAt.current
          if (started && done < scoreable.length && done > 0) {
            const elapsedSec = (Date.now() - started) / 1000
            const rate = done / elapsedSec
            const remaining = Math.round((scoreable.length - done) / rate)
            setEtaSeconds(Number.isFinite(remaining) ? Math.max(0, remaining) : null)
          } else {
            setEtaSeconds(null)
          }
        }
      } catch (err) {
        if (!cancelled) {
          setScoreError(err.message)
          if (err.status === 401) {
            setAuthExpired(true)
            setExpired(true)
            setBackendAvailable(true)
          } else {
            setBackendAvailable(false)
          }
        }
      } finally {
        setScoring(false)
        useStore.getState().setIsScoring(false)
        setEtaSeconds(null)
        scoringStartedAt.current = null
      }
    }

    score()

    return () => {
      cancelled = true
    }
  }, [scoringRunId, loadingComplete])

  const scoreableCount = order.filter((id) => {
    const p = photos[id]
    return p && !p.isRaw
  }).length

  return {
    scoring,
    scoredCount,
    scoreError,
    backendAvailable,
    scoreableCount,
    authExpired,
    beginScoring,
    etaSeconds,
    scoringStarted: scoringRunId > 0,
  }
}
