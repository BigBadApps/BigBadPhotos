import { getCsrfHeaders } from '../utils/csrf';
// Relative URLs — works on localhost (proxied by Vite) and on the Tailscale HTTPS hostname.
export async function checkHealth() {
  const res = await fetch('/health')
  if (!res.ok) throw new Error(`Health check failed: ${res.status}`)
  return res.json()
}

/** Build a human-readable message from a failed /rank JSON body. */
function formatRankErrorBody(body, status) {
  if (!body || typeof body !== 'object') return `HTTP ${status}`
  const code = body.error
  const detail = body.detail
  const fn = body.filename ? ` — ${body.filename}` : ''
  const id = body.id && !body.filename ? ` — id ${body.id}` : ''
  // Prefer server detail over generic error codes (scoring_failed, all_scoring_failed, …)
  if (detail) return `${detail}${fn || id}`
  if (code === 'all_scoring_failed' && Array.isArray(body.ranking_errors) && body.ranking_errors[0]) {
    const e0 = body.ranking_errors[0]
    return `${e0.detail || 'unknown'} — ${e0.filename || e0.id}`
  }
  if (code) return `${code}${fn || id}`
  return `HTTP ${status}`
}

/**
 * POST /rank. Returns successful rows plus per-file failures (partial batches are OK).
 * @returns {{ results: object[], rankingErrors: object[] }}
 */
export async function rankPhotos(photos) {
  const formData = new FormData()
  formData.append('manifest', JSON.stringify(photos.map(p => ({ id: p.id, filename: p.filename }))))
  for (const photo of photos) {
    formData.append(photo.id, photo.file, photo.filename)
  }

  const res = await fetch('/rank', { method: 'POST', body: formData, credentials: 'include', headers: getCsrfHeaders() })
  let body = {}
  try {
    body = await res.json()
  } catch {
    body = {}
  }

  if (!res.ok) {
    const err = new Error(formatRankErrorBody(body, res.status))
    err.status = res.status
    err.body = body
    throw err
  }

  const results = Array.isArray(body.results) ? body.results : []
  const rankingErrors = Array.isArray(body.ranking_errors) ? body.ranking_errors : []
  return { results, rankingErrors }
}
