/**
 * useCameraBridge — WebSocket listener for all Camera Bridge events.
 *
 * Handles:
 *   burst_ready   → addBurst (BurstScrubber / BurstTray)
 *   frame_arrived → addLiveFrame (Live Feed Grid in CullingView)
 *
 * Reconnects with exponential backoff (1s → 30s max).
 * Polls /burst/status on connect to initialize bridge state.
 */
import { useEffect, useRef } from 'react'
import { useStore } from '../store'

const MAX_BACKOFF = 30_000

export function useCameraBridge() {
  const addBurst      = useStore(s => s.addBurst)
  const addLiveFrame  = useStore(s => s.addLiveFrame)
  const setBridgeStatus = useStore(s => s.setBridgeStatus)
  const backoff       = useRef(1_000)
  const unmounted     = useRef(false)

  // Fetch bridge status on mount
  useEffect(() => {
    fetch('/burst/status', { credentials: 'include' })
      .then(r => r.json())
      .then(d => setBridgeStatus({ enabled: d.bridgeEnabled, ftpPort: d.ftpPort }))
      .catch(() => setBridgeStatus({ enabled: false, ftpPort: null }))
  }, [setBridgeStatus])

  useEffect(() => {
    function connect() {
      if (unmounted.current) return
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(`${proto}://${window.location.host}/ws`)

      ws.onopen = () => {
        backoff.current = 1_000
        ws._hb = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send('ping')
        }, 25_000)
      }

      ws.onmessage = ({ data }) => {
        try {
          const msg = JSON.parse(data)
          if (msg.type === 'burst_ready')   addBurst(msg)
          if (msg.type === 'frame_arrived') addLiveFrame(msg)
        } catch (_) {}
      }

      ws.onclose = () => {
        clearInterval(ws._hb)
        if (!unmounted.current) {
          setTimeout(connect, backoff.current)
          backoff.current = Math.min(backoff.current * 2, MAX_BACKOFF)
        }
      }
    }

    connect()
    return () => { unmounted.current = true }
  }, [addBurst, addLiveFrame])
}
