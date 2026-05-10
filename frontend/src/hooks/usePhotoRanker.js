import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { rankPhotos } from '../api/client'

const RANK_BATCH_SIZE = 100 // stay under backend's 200 limit with headroom

export function usePhotoRanker(loadingComplete) {
  const photos = useStore(state => state.photos)
  const order = useStore(state => state.order)
  const sourceDir = useStore(state => state.sourceDir)
  const batchUpdateScores = useStore(state => state.batchUpdateScores)

  const [scoring, setScoring] = useState(false)
  const [scoredCount, setScoredCount] = useState(0)
  const [scoreError, setScoreError] = useState(null)
  const [backendAvailable, setBackendAvailable] = useState(true)

  const ranRef = useRef(false)

  // Reset when the user picks a new source folder so scoring re-runs
  useEffect(() => {
    ranRef.current = false
    setScoredCount(0)
    setScoreError(null)
    setBackendAvailable(true)
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
      setScoreError(null)
      setScoredCount(0)

      try {
        for (let i = 0; i < scoreable.length; i += RANK_BATCH_SIZE) {
          if (cancelled) break

          const batch = scoreable.slice(i, i + RANK_BATCH_SIZE)
          const results = await rankPhotos(batch)

          if (cancelled) break

          batchUpdateScores(results)
          setScoredCount(i + batch.length)
        }
      } catch (err) {
        if (!cancelled) {
          // Backend may not be running — fail silently, just mark unavailable
          setScoreError(err.message)
          setBackendAvailable(false)
        }
      } finally {
        if (!cancelled) setScoring(false)
      }
    }

    score()

    return () => { cancelled = true }
  }, [loadingComplete]) // eslint-disable-line react-hooks/exhaustive-deps

  const scoreableCount = order.filter(id => {
    const p = photos[id]
    return p && !p.isRaw
  }).length

  return { scoring, scoredCount, scoreError, backendAvailable, scoreableCount }
}
