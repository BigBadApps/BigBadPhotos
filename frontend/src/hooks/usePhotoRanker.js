import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { rankPhotos } from '../api/client'

const RANK_BATCH_SIZE = 100 // stay under backend's 200 limit with headroom

export function usePhotoRanker(loadingComplete) {
  const photos = useStore(state => state.photos)
  const order = useStore(state => state.order)
  const sourceDir = useStore(state => state.sourceDir)
  const batchUpdateScores = useStore(state => state.batchUpdateScores)
  const setIsScoring = useStore(state => state.setIsScoring)
  const setScoringProgress = useStore(state => state.setScoringProgress)

  const [scoring, setScoring] = useState(false)
  const [scoredCount, setScoredCount] = useState(0)
  const [scoreError, setScoreError] = useState(null)
  const [backendAvailable, setBackendAvailable] = useState(true)
  const [authExpired, setAuthExpired] = useState(false)

  const ranRef = useRef(false)

  // Reset when the user picks a new source folder so scoring re-runs
  useEffect(() => {
    ranRef.current = false
    setScoredCount(0)
    setScoreError(null)
    setBackendAvailable(true)
    setAuthExpired(false)
  }, [sourceDir])

  useEffect(() => {
    // Only run once after the loader reports it's done
    if (!loadingComplete || ranRef.current || order.length === 0) return
    ranRef.current = true

    // Only score web-renderable photos — backend can't decode RAW
    const scoreable = order
      .map(id => photos[id])
      .filter(p => p && !p.isRaw && p.file)

    if (scoreable.length === 0) return

    let cancelled = false

    async function score() {
      setScoring(true)
      setIsScoring(true)
      setScoreError(null)
      setScoredCount(0)
      setScoringProgress(0, scoreable.length)

      try {
        for (let i = 0; i < scoreable.length; i += RANK_BATCH_SIZE) {
          if (cancelled) break

          const batch = scoreable.slice(i, i + RANK_BATCH_SIZE)
          const results = await rankPhotos(batch)

          if (cancelled) break

          batchUpdateScores(results)
          const done = i + batch.length
          setScoredCount(done)
          setScoringProgress(done, scoreable.length)
        }
      } catch (err) {
        if (!cancelled) {
          setScoreError(err.message)
          if (err.status === 401) {
            // Session expired — backend is up but auth needs to be renewed
            setAuthExpired(true)
          } else {
            setBackendAvailable(false)
          }
        }
      } finally {
        if (!cancelled) {
          setScoring(false)
          setIsScoring(false)
          // Don't reset progress to 100% on error; the loop already set correct progress
        }
      }
    }

    score()

    return () => { cancelled = true }
  }, [loadingComplete]) // eslint-disable-line react-hooks/exhaustive-deps

  const scoreableCount = order.filter(id => {
    const p = photos[id]
    return p && !p.isRaw
  }).length

  return { scoring, scoredCount, scoreError, backendAvailable, scoreableCount, authExpired }
}
