/** BigBadPhotos autonomous-mode sidecar: `<image>.bbp.json` next to the image. */

export const SIDECAR_SUFFIX = '.bbp.json'

export function sidecarFileName(imageFileName) {
  return `${imageFileName}${SIDECAR_SUFFIX}`
}

/** Build JSON-serializable payload written beside each processed image. */
export function buildSidecarPayload({ filename, result, threshold, exported }) {
  return {
    schema:         'bigbadphotos.processed.v1',
    processed_at:   new Date().toISOString(),
    filename,
    overall_score:  result.overall_score,
    rank:           result.rank,
    exported,
    threshold_used: threshold,
    metrics: {
      sharpness: result.sharpness,
      exposure:  result.exposure,
      noise:     result.noise,
      contrast:  result.contrast,
    },
    subject:       result.subject ?? null,
    composition: result.composition ?? null,
    burst_group:   result.burst_group ?? null,
    burst_size:    result.burst_size ?? null,
    is_burst_best: result.is_burst_best ?? null,
  }
}

/**
 * Map a parsed sidecar object to a `/rank`-shaped row for `batchUpdateScores`.
 * @param {object} data — parsed JSON
 * @param {string} idForStore — photo id in zustand (local: filename; Drive: file id)
 */
/**
 * Merge Topaz edit settings into an existing (or new) sidecar payload,
 * preserving any ranking fields already present.
 * @param {object|null} existing — parsed sidecar JSON, or null if none exists yet
 */
export function applyEditPatch(existing, { filename, enhancements, editedFilename }) {
  const base = existing && existing.schema === 'bigbadphotos.processed.v1'
    ? existing
    : { schema: 'bigbadphotos.processed.v1', filename }
  return {
    ...base,
    filename,
    edit: {
      enhancements,
      edited_filename: editedFilename,
      edited_at: new Date().toISOString(),
    },
  }
}

export function sidecarToRankRow(data, idForStore) {
  if (!data || data.schema !== 'bigbadphotos.processed.v1') return null
  const os = data.overall_score
  if (!Number.isFinite(os)) return null
  const m = data.metrics || {}
  return {
    id:            idForStore,
    overall_score: os,
    rank:          Number.isFinite(data.rank) ? data.rank : null,
    sharpness:     m.sharpness,
    exposure:      m.exposure,
    noise:         m.noise,
    contrast:      m.contrast,
    subject:       data.subject ?? {},
    composition:   data.composition ?? null,
    burst_group:   data.burst_group ?? null,
    burst_size:    data.burst_size ?? null,
    is_burst_best: data.is_burst_best ?? true,
  }
}
