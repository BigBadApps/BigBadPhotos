// frontend/src/hooks/useServerAutonomous.js
// Remote control for the Mac-side session worker (/autonomous/*).
import { useCallback, useEffect, useRef, useState } from 'react'

const POLL_MS = 5000

export function useServerAutonomous() {
  const [available, setAvailable] = useState(false)
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)
  const timerRef = useRef(null)

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/autonomous/status', { credentials: 'include' })
      if (!res.ok) throw new Error(`status ${res.status}`)
      const body = await res.json()
      setStatus(body)
      return body
    } catch (err) {
      setError(err.message)
      return null
    }
  }, [])

  useEffect(() => {
    let alive = true
    fetch('/auth/config', { credentials: 'include' })
      .then(r => r.ok ? r.json() : {})
      .then(cfg => { if (alive) setAvailable(!!cfg.worker) })
      .catch(() => {})
    fetchStatus()
    return () => { alive = false }
  }, [fetchStatus])

  useEffect(() => {
    const running = !!status?.running
    clearInterval(timerRef.current)
    if (running) timerRef.current = setInterval(fetchStatus, POLL_MS)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [status?.running, fetchStatus])

  const start = useCallback(async (config) => {
    setError(null)
    const res = await fetch('/autonomous/start', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      setError(body.detail || body.error || 'Could not start session')
      return false
    }
    await fetchStatus()
    return true
  }, [fetchStatus])

  const stop = useCallback(async () => {
    await fetch('/autonomous/stop', { method: 'POST', credentials: 'include' })
    await fetchStatus()
  }, [fetchStatus])

  return { available, running: !!status?.running, status, error, start, stop }
}
