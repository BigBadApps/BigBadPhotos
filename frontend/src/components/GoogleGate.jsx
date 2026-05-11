import { useCallback, useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms))
}

function loadGis() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve()

    const existing = document.querySelector('script[data-bbp-gis="1"]')
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error('GIS load failed')), { once: true })
      return
    }

    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.defer = true
    script.dataset.bbpGis = '1'
    script.addEventListener('load', () => resolve(), { once: true })
    script.addEventListener('error', () => reject(new Error('GIS load failed')), { once: true })
    document.head.appendChild(script)
  })
}

async function waitForBackend({ maxMs = 60000, intervalMs = 1500 } = {}) {
  const started = Date.now()
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await fetch('/health', { cache: 'no-store' })
      if (res.ok) return { ok: true, elapsedMs: Date.now() - started }
    } catch {
      // ignore and retry
    }

    const elapsed = Date.now() - started
    if (elapsed >= maxMs) return { ok: false, elapsedMs: elapsed }
    await sleep(intervalMs)
  }
}

export default function GoogleGate({ children }) {
  const setAuthSessionExpired = useStore(s => s.setAuthSessionExpired)
  // null = loading; false = not authenticated
  const [user, setUser] = useState(null)
  const [checking, setChecking] = useState(true)
  const [error, setError] = useState(null)
  const [backend, setBackend] = useState({ warming: false, ok: null })

  const canShowSignin = useMemo(() => user === false, [user])

  const handleCredentialResponse = useCallback(async (response) => {
    setError(null)
    try {
      const res = await fetch('/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: response.credential }),
      })

      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        setAuthSessionExpired(false)
        setUser(data.user)
      } else if (res.status === 403) {
        setError('This Google account is not authorized.')
        setUser(false)
      } else {
        setError(data.detail || data.error || 'Sign-in failed.')
        setUser(false)
      }
    } catch {
      setError('Network error. Is the backend running?')
      setUser(false)
    }
  }, [])

  // Check existing session on mount
  useEffect(() => {
    let cancelled = false

    const warmupTimer = setTimeout(() => {
      if (!cancelled) setBackend({ warming: true, ok: null })
    }, 800)

    waitForBackend({ maxMs: 60000, intervalMs: 1500 })
      .then((r) => {
        if (cancelled) return
        setBackend({ warming: false, ok: r.ok })
      })
      .catch(() => {
        if (cancelled) return
        setBackend({ warming: false, ok: false })
      })

    fetch('/auth/me')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('not_authed'))))
      .then(data => {
        if (!cancelled) {
          setAuthSessionExpired(false)
          setUser(data.user)
        }
      })
      .catch(() => {
        if (!cancelled) setUser(false)
      })
      .finally(() => {
        if (!cancelled) setChecking(false)
      })

    return () => {
      cancelled = true
      clearTimeout(warmupTimer)
    }
  }, [])

  // Initialize GIS when not authenticated
  useEffect(() => {
    if (!canShowSignin) return
    if (!CLIENT_ID) {
      setError('Missing VITE_GOOGLE_CLIENT_ID (set it in frontend/.env.local).')
      return
    }

    let cancelled = false

    loadGis()
      .then(() => {
        if (cancelled) return
        window.google.accounts.id.initialize({
          client_id: CLIENT_ID,
          callback: handleCredentialResponse,
          auto_select: true,
          use_fedcm_for_prompt: true,
        })
        window.google.accounts.id.renderButton(document.getElementById('g_signin_btn'), {
          type: 'standard',
          theme: 'filled_black',
          size: 'large',
          text: 'signin_with',
          shape: 'rectangular',
          width: 280,
        })
        window.google.accounts.id.prompt()
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load Google Sign-In.')
      })

    return () => {
      cancelled = true
      if (window.google?.accounts?.id) window.google.accounts.id.cancel()
    }
  }, [canShowSignin, handleCredentialResponse])

  // Loading state
  if (checking) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface-container-lowest">
        <div className="text-center">
          <h1 className="font-display font-bold text-on-surface text-2xl tracking-wide">
            BIGBADPHOTOS
          </h1>
          <p className="text-on-surface-variant text-sm mt-2 tracking-wider">
            {backend.warming ? 'WAKING SERVER…' : 'AUTHENTICATING…'}
          </p>
        </div>
      </div>
    )
  }

  // Authenticated — render app
  if (user) return children

  // Sign-in screen
  return (
    <div className="flex h-screen items-center justify-center bg-surface-container-lowest">
      <div className="flex flex-col items-center gap-6 w-72">
        <div className="text-center">
          <div className="w-12 h-12 bg-primary/10 flex items-center justify-center mx-auto mb-4">
            <span
              className="material-symbols-outlined text-primary"
              style={{ fontSize: '28px', fontVariationSettings: "'FILL' 1" }}
            >
              lock
            </span>
          </div>
          <h1 className="font-display font-bold text-on-surface text-2xl tracking-wide">
            BIGBADPHOTOS
          </h1>
          <p className="text-on-surface-variant text-sm mt-1 tracking-wider">
            Sign in to continue
          </p>
        </div>

        {error && (
          <p className="text-error text-center tracking-widest" style={{ fontSize: '10px' }}>
            {error}
          </p>
        )}

        <div id="g_signin_btn" />
      </div>
    </div>
  )
}

