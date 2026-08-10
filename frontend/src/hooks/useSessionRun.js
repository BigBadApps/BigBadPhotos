import { useCallback, useEffect, useRef, useState } from 'react'
import * as sessionsClient from '../api/sessionsClient'
import { useStore } from '../store'

const ACTIVE_MS = 3000
const IDLE_MS = 15000

/**
 * Poll `GET /runs/active`: every 3s while a run is running, 15s when idle.
 * The interval is a self-rescheduling setTimeout whose delay is chosen from
 * `runningRef.current` at schedule time — never captured from a stale render.
 */
export function useSessionRun() {
  const runStatus = useStore((s) => s.runStatus)
  const setRunStatus = useStore((s) => s.setRunStatus)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const timerRef = useRef(null)
  const runningRef = useRef(false)
  const aliveRef = useRef(true)

  const doPoll = useCallback(async () => {
    setLoading(true)
    try {
      const status = await sessionsClient.activeRun()
      runningRef.current = status.running === true
      setRunStatus(status)
      setError(null)
      return status
    } catch (err) {
      setError(err.message)
      return null
    } finally {
      setLoading(false)
    }
  }, [setRunStatus])

  const schedule = useCallback(() => {
    window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(async () => {
      await doPoll()
      if (aliveRef.current) schedule()
    }, runningRef.current ? ACTIVE_MS : IDLE_MS)
  }, [doPoll])

  useEffect(() => {
    aliveRef.current = true
    doPoll()
    schedule()
    return () => {
      aliveRef.current = false
      window.clearTimeout(timerRef.current)
    }
  }, [doPoll, schedule])

  const refresh = useCallback(() => {
    doPoll()
    schedule()
  }, [doPoll, schedule])

  const stop = useCallback(async () => {
    try {
      await sessionsClient.stopRun()
    } catch (err) {
      setError(err.message)
    }
    refresh()
  }, [refresh])

  return { status: runStatus, loading, error, refresh, stop }
}
