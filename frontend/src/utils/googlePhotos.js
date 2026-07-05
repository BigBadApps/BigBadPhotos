// frontend/src/utils/googlePhotos.js
// Backend-proxied Google Photos access. The API only ever lists/uploads to
// albums this app created (Google Photos Library API post-2025 rules).

async function jsonOrThrow(res, fallbackMsg) {
  if (res.ok) return res.json()
  const body = await res.json().catch(() => ({}))
  const err = new Error(body.detail || body.error || fallbackMsg)
  err.status = res.status
  err.code = body.error
  throw err
}

export function isPhotosAuthError(error) {
  if (error?.status === 401) return true
  const msg = (error?.message || '').toLowerCase()
  return msg.includes('not_authorized') || msg.includes('not_authenticated')
    || msg.includes('connect google')
}

export function serverGoogleConnectUrl() {
  return '/google/oauth/start'
}

export function defaultAlbumTitle() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `BBP ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export async function listPhotosAlbums() {
  const res = await fetch('/photos/albums', { credentials: 'include' })
  const body = await jsonOrThrow(res, 'Could not list Google Photos albums')
  return body.albums || []
}

export async function createPhotosAlbum(title) {
  const res = await fetch('/photos/albums', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  const body = await jsonOrThrow(res, 'Could not create Google Photos album')
  return body.album
}

export async function uploadPhotoToAlbum(albumId, file) {
  const form = new FormData()
  form.append('albumId', albumId)
  form.append('file', file, file.name)
  const res = await fetch('/photos/upload', {
    method: 'POST',
    credentials: 'include',
    body: form,
  })
  return jsonOrThrow(res, 'Could not upload to Google Photos')
}
