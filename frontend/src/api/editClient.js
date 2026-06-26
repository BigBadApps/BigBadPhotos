// Topaz edit endpoints (LOCAL ONLY — backend runs Topaz on this machine and
// operates on absolute local paths). Relative URLs, proxied by Vite in dev.

/** Build a /edit/file URL for the before/after viewer. */
export function editFileUrl(sourceDir, name, variant = 'original') {
  const params = new URLSearchParams({ dir: sourceDir, name, variant })
  return `/edit/file?${params}`
}

/** Human-readable message from a failed /edit JSON body. */
function formatEditError(body, status) {
  if (!body || typeof body !== 'object') return `HTTP ${status}`
  return body.detail || body.error || `HTTP ${status}`
}

/**
 * POST /edit — run Topaz on one local image, non-destructively.
 * @param {object} opts
 * @param {string} opts.sourceDir   absolute folder path holding the image
 * @param {string} opts.filename    bare filename within sourceDir
 * @param {object} [opts.enhancements] e.g. { sharpen: true, noise: true }
 * @param {number} [opts.iso]       used for defaults only if enhancements omitted
 * @param {string} [opts.format]    jpg|jpeg|png|tif|tiff|dng|preserve
 * @param {number} [opts.quality]   0-100
 * @param {boolean} [opts.overwrite]
 * @param {number} [opts.timeoutS]
 * @returns {Promise<object>} the wrapper result (ok, status, edited_filename, edited_url, original_url, ...)
 */
export async function editPhoto({
  sourceDir, filename, enhancements, iso,
  format = 'jpg', quality = 95, overwrite = false, timeoutS = 600,
}) {
  const res = await fetch('/edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      source_dir: sourceDir,
      filename,
      enhancements,
      iso,
      format,
      quality,
      overwrite,
      timeout_s: timeoutS,
    }),
  })

  let body = {}
  try { body = await res.json() } catch { body = {} }

  if (!res.ok) {
    const err = new Error(formatEditError(body, res.status))
    err.status = res.status
    err.body = body
    throw err
  }
  return body
}
