import { getCsrfHeaders } from '../utils/csrf'

async function jsonFetch(path, { method = 'GET', body } = {}) {
  const isMutating = method !== 'GET'
  const res = await fetch(path, {
    method,
    credentials: 'include',
    ...(isMutating ? { headers: { 'Content-Type': 'application/json', ...getCsrfHeaders() } } : {}),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  if (!res.ok) {
    const parsed = await res.json().catch(() => ({}))
    throw new Error(parsed.detail || parsed.error || 'Request failed')
  }
  return res.json()
}

export function listSessions() {
  return jsonFetch('/sessions')
}

export function createSession(payload) {
  return jsonFetch('/sessions', { method: 'POST', body: payload })
}

export function getSession(sessionId) {
  return jsonFetch(`/sessions/${sessionId}`)
}

export function updateSession(sessionId, payload) {
  return jsonFetch(`/sessions/${sessionId}`, { method: 'PUT', body: payload })
}

export function deleteSession(sessionId) {
  return jsonFetch(`/sessions/${sessionId}`, { method: 'DELETE' })
}

export function preflight(sessionId) {
  return jsonFetch(`/sessions/${sessionId}/preflight`, { method: 'POST' })
}

export function startRun(sessionId) {
  return jsonFetch(`/sessions/${sessionId}/start`, { method: 'POST' })
}

export function stopRun() {
  return jsonFetch('/runs/active/stop', { method: 'POST' })
}

export function activeRun() {
  return jsonFetch('/runs/active')
}

export function listPhotos(runId, { state, limit, offset } = {}) {
  const params = new URLSearchParams()
  if (state) params.set('state', state)
  if (limit != null) params.set('limit', String(limit))
  if (offset != null) params.set('offset', String(offset))
  const query = params.toString()
  return jsonFetch(`/runs/${runId}/photos${query ? `?${query}` : ''}`)
}

export function decide(photoId, decision) {
  return jsonFetch(`/photos/${photoId}/decision`, { method: 'POST', body: { decision } })
}

export function approveAll(runId) {
  return jsonFetch(`/runs/${runId}/approve-all`, { method: 'POST' })
}

export function getSettings() {
  return jsonFetch('/settings')
}

export function putSettings(payload) {
  return jsonFetch('/settings', { method: 'PUT', body: payload })
}

export function createDriveFolder(parentId, name) {
  return jsonFetch('/drive/folders', { method: 'POST', body: { parentId, name } })
}
