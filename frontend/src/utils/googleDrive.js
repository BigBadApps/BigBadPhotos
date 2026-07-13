import { getCsrfHeaders } from './csrf';
const GIS_SRC = 'https://accounts.google.com/gsi/client'
const DRIVE_OAUTH_PENDING_KEY = 'bbp_drive_oauth_pending'

export const DRIVE_SCOPES = {
  read: 'https://www.googleapis.com/auth/drive.readonly',
  // Full Drive scope is required to upload into folders chosen in our in-app browser.
  write: 'https://www.googleapis.com/auth/drive',
}

let gisPromise
let driveAccessInflight = null
let cachedDriveConfig = null

function formatDrivePopupError(error) {
  const type = error?.type || 'unknown'
  if (type === 'popup_closed') return 'Google sign-in was cancelled.'
  if (type === 'popup_failed_to_open') {
    return 'Google could not open the sign-in window. Allow pop-ups for this site, or sign in again to use a full-page Google redirect.'
  }
  if (type === 'non-oauth') {
    return 'Google sign-in is unavailable in this browser. Try a normal window (not private) or another browser.'
  }
  return error?.message || 'Google sign-in failed.'
}

function formatDriveOAuthError(code, detail) {
  if (code === 'access_denied') return 'Google Drive access was denied.'
  if (code === 'popup_closed_by_user') return 'Google sign-in was cancelled.'
  return detail || code || 'Google sign-in failed.'
}

function formatDriveNetworkError(error) {
  if (error instanceof TypeError) {
    return 'Could not reach the BigBadPhotos server. Start Flask on port 8002, or use the Vite dev server on port 5173.'
  }
  return error?.message || 'Google Drive request failed.'
}

export function isDriveBackendUnavailable(error) {
  if (error instanceof TypeError) return true
  const message = error?.message || ''
  return message.startsWith('Could not reach the BigBadPhotos server')
}

export function isDriveExportAbortError(error) {
  if (isDriveBackendUnavailable(error)) return true
  const message = (error?.message || '').toLowerCase()
  return (
    message.includes('drive_upload_failed')
    || message.includes('insufficient permission')
    || message.includes('insufficient authentication')
    || message.includes('invalid credentials')
    || message.includes('access denied')
    || message.includes('unauthorized')
    || message.includes('forbidden')
    || message.includes('scope')
  )
}

function isRetryableSilentAuthError(error) {
  const message = (error?.message || '').toLowerCase()
  return (
    message.includes('interaction_required')
    || message.includes('login_required')
    || message.includes('consent_required')
    || message.includes('no access token')
    || message.includes('popup_failed_to_open')
  )
}

function redirectUri() {
  return `${window.location.origin}${window.location.pathname}`
}

function beginTokenRequest({ clientId, scope, prompt, uxMode, allowRedirect, resolve, reject, finish }) {
  try {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope,
      include_granted_scopes: true,
      ux_mode: uxMode,
      redirect_uri: uxMode === 'redirect' ? redirectUri() : undefined,
      callback: (response) => {
        if (response.error) {
          if (!prompt && isRetryableSilentAuthError({ message: response.error })) {
            beginTokenRequest({
              clientId,
              scope,
              prompt: 'consent',
              uxMode,
              allowRedirect,
              resolve,
              reject,
              finish,
            })
            return
          }
          finish(reject, new Error(formatDriveOAuthError(response.error, response.error_description)))
          return
        }
        if (!response.access_token) {
          finish(reject, new Error('Google did not return an access token.'))
          return
        }
        finish(resolve, response.access_token)
      },
      error_callback: (error) => {
        if (allowRedirect && error?.type === 'popup_failed_to_open') {
          beginTokenRequest({
            clientId,
            scope,
            prompt: prompt || 'consent',
            uxMode: 'redirect',
            allowRedirect: false,
            resolve,
            reject,
            finish,
          })
          return
        }
        finish(reject, new Error(formatDrivePopupError(error)))
      },
    })
    client.requestAccessToken({ prompt })
  } catch (error) {
    finish(reject, error instanceof Error ? error : new Error('Could not start Google authorization.'))
  }
}

export function loadGoogleIdentityScript() {
  if (typeof window === 'undefined') return Promise.reject(new Error('Drive is browser-only'))
  if (window.google?.accounts?.oauth2) return Promise.resolve()
  if (gisPromise) return gisPromise
  gisPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${GIS_SRC}"]`)
    if (existing) {
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', () => reject(new Error('Google Identity script failed to load')))
      return
    }
    const script = document.createElement('script')
    script.src = GIS_SRC
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Google Identity script failed to load'))
    document.head.appendChild(script)
  })
  return gisPromise
}

export async function fetchDriveConfig() {
  const res = await fetch('/auth/config', { credentials: 'include' })
  if (!res.ok) throw new Error('Could not load auth config')
  return res.json()
}

export async function prepareDriveAuth() {
  const config = await fetchDriveConfig()
  if (!config.drive || !config.googleClientId) {
    throw new Error(
      'Google Drive is not configured on this server. Set GOOGLE_CLIENT_ID in the project .env (or VITE_GOOGLE_CLIENT_ID in frontend/.env.local), enable the Google Drive API, then restart Flask on port 8002.',
    )
  }
  await loadGoogleIdentityScript()
  cachedDriveConfig = config
  return config
}

export function getCachedDriveConfig() {
  return cachedDriveConfig
}

export async function hasValidDriveSession() {
  try {
    const res = await fetch('/drive/status', { credentials: 'include' })
    if (!res.ok) return false
    const data = await res.json()
    return Boolean(data.driveAuthorized)
  } catch {
    return false
  }
}

export function requestDriveAccessFromGesture({ clientId, scope, prompt = '', allowRedirect = true }) {
  if (!window.google?.accounts?.oauth2) {
    return Promise.reject(new Error('Google sign-in is still loading. Wait a moment and try again.'))
  }
  if (driveAccessInflight) return driveAccessInflight

  driveAccessInflight = new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeoutId)
      fn(value)
    }

    const timeoutId = window.setTimeout(() => {
      finish(reject, new Error('Google authorization timed out. Finish sign-in in the Google window, then try again.'))
    }, 120000)

    beginTokenRequest({
      clientId,
      scope,
      prompt,
      uxMode: 'popup',
      allowRedirect,
      resolve,
      reject,
      finish,
    })
  })

  return driveAccessInflight.finally(() => {
    driveAccessInflight = null
  })
}

export function beginDriveRedirectAuth(target, scope) {
  const clientId = cachedDriveConfig?.googleClientId
  if (!clientId || !window.google?.accounts?.oauth2) {
    throw new Error('Google sign-in is still loading. Wait a moment and try again.')
  }
  sessionStorage.setItem(DRIVE_OAUTH_PENDING_KEY, target)
  beginTokenRequest({
    clientId,
    scope,
    prompt: 'consent',
    uxMode: 'redirect',
    allowRedirect: false,
    resolve: () => {},
    reject: (error) => { throw error },
    finish: (fn, value) => { fn(value) },
  })
}

export async function resumeDriveRedirectIfNeeded() {
  const pending = sessionStorage.getItem(DRIVE_OAUTH_PENDING_KEY)
  const hash = window.location.hash
  if (!pending || !hash.includes('access_token=')) return null

  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const accessToken = params.get('access_token')
  if (!accessToken) return null

  const cleanUrl = `${window.location.pathname}${window.location.search}`
  window.history.replaceState(null, '', cleanUrl)
  sessionStorage.removeItem(DRIVE_OAUTH_PENDING_KEY)
  await authorizeDriveToken(accessToken)
  return pending
}

export async function authorizeDriveToken(accessToken) {
  const res = await fetch('/drive/authorize', {
    headers: {
      'Content-Type': 'application/json',
      ...getCsrfHeaders()
    },
    method: 'POST',
    credentials: 'include',
    // original headers replaced by csrf patch
    body: JSON.stringify({ accessToken }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.detail || body.error || 'Drive authorization failed')
  }
  return res.json()
}

export async function ensureDriveWriteSession() {
  const config = cachedDriveConfig || await prepareDriveAuth()
  let accessToken
  try {
    accessToken = await requestDriveAccessFromGesture({
      clientId: config.googleClientId,
      scope: DRIVE_SCOPES.write,
      prompt: '',
    })
  } catch (error) {
    if (!isRetryableSilentAuthError(error)) throw error
    accessToken = await requestDriveAccessFromGesture({
      clientId: config.googleClientId,
      scope: DRIVE_SCOPES.write,
      prompt: 'consent',
    })
  }
  await authorizeDriveToken(accessToken)
  return config
}

export async function connectDriveForPicker(scope) {
  const config = cachedDriveConfig || await prepareDriveAuth()
  if (scope === DRIVE_SCOPES.read && await hasValidDriveSession()) return config

  let accessToken
  try {
    accessToken = await requestDriveAccessFromGesture({
      clientId: config.googleClientId,
      scope,
      prompt: '',
    })
  } catch (error) {
    if (!isRetryableSilentAuthError(error)) throw error
    accessToken = await requestDriveAccessFromGesture({
      clientId: config.googleClientId,
      scope,
      prompt: 'consent',
    })
  }

  await authorizeDriveToken(accessToken)
  return config
}

export async function browseDrive(parentId = 'root', mode = 'folders') {
  const params = new URLSearchParams({ parentId, mode })
  const res = await fetch(`/drive/browse?${params}`, { credentials: 'include' })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.detail || body.error || 'Could not browse Google Drive')
  }
  return res.json()
}

export async function downloadDriveFile(fileId, { name, mimeType } = {}) {
  const params = new URLSearchParams()
  if (name) params.set('name', name)
  if (mimeType) params.set('mimeType', mimeType)
  const query = params.toString()
  const res = await fetch(
    `/drive/files/${encodeURIComponent(fileId)}${query ? `?${query}` : ''}`,
    { credentials: 'include' },
  )
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.detail || body.error || 'Could not download file')
  }
  const blob = await res.blob()
  const headerName = res.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1]
  const resolvedName = name || (headerName ? decodeURIComponent(headerName) : fileId)
  const type = mimeType || blob.type || 'application/octet-stream'
  return new File([blob], resolvedName, { type })
}

export async function uploadDriveFile(parentId, file) {
  const form = new FormData()
  form.append('parentId', parentId)
  form.append('file', file, file.name)
  let res
  try {
    res = await fetch('/drive/files', {
      headers: getCsrfHeaders(),
      method: 'POST',
      credentials: 'include',
      body: form,
    })
  } catch (error) {
    throw new Error(formatDriveNetworkError(error))
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.detail || body.error || 'Could not upload file')
  }
  return res.json()
}
