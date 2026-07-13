/**
 * useAutonomousMode — fire-and-forget photo pipeline.
 *
 * When enabled:
 *   1. [Drive only] Eagerly acquires write scope at toggle time (user gesture)
 *   2. [Local only] Upgrades source handle to readwrite (Safari fallback included)
 *   3. Loads all images from source; skips files with existing .bbp.json sidecars
 *   4. Scores scoreable images via POST /rank (batched, RANK_BATCH_SIZE=100)
 *   5. Exports qualifying images (overall_score >= threshold; non-burst OR best-in-burst)
 *   6. Writes <filename>.bbp.json sidecar to source folder for every processed image
 *   7. Polls every POLL_INTERVAL ms; processes only new arrivals
 *
 * Drive source specifics:
 *   - Uses /drive/browse?mode=all to get images + existing sidecars in one call
 *   - Requires write scope (DRIVE_SCOPES.write) acquired eagerly at toggle time
 *   - Sidecar detection: checks if <filename>.bbp.json appears in Drive listing
 *
 * Local FSAPI specifics:
 *   - Upgrades source handle to readwrite for sidecar writes
 *   - Safari fallback: showDirectoryPicker({ mode: 'readwrite' }) instead of requestPermission()
 *
 * Disabled for _ios sources (no directory handle to poll).
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { rankPhotos } from '../api/client'
import { useStore } from '../store'
import {
  browseDrive,
  downloadDriveFile,
  ensureDriveWriteSession,
  uploadDriveFile,
} from '../utils/googleDrive'
import {
  SIDECAR_SUFFIX,
  sidecarFileName,
  buildSidecarPayload,
} from '../utils/bbpSidecar'

const POLL_INTERVAL   = 30_000  // ms
const RANK_BATCH_SIZE = 100
const WEB_FORMATS     = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp'])
const RAW_FORMATS     = new Set(['raw', 'arw', 'cr2', 'cr3', 'nef', 'dng', 'orf', 'rw2', 'raf', 'tif', 'tiff'])

// ── FSAPI helpers ─────────────────────────────────────────────────────────────

async function sidecarExistsLocal(dirHandle, filename) {
  try { await dirHandle.getFileHandle(sidecarFileName(filename)); return true }
  catch { return false }
}

async function writeSidecarLocal(dirHandle, filename, json) {
  const h = await dirHandle.getFileHandle(sidecarFileName(filename), { create: true })
  const w = await h.createWritable()
  await w.write(new Blob([json], { type: 'application/json' }))
  await w.close()
}

async function exportFileLocal(destHandle, file, filename) {
  const h = await destHandle.getFileHandle(filename, { create: true })
  const w = await h.createWritable()
  await w.write(file)
  await w.close()
}

// ── Drive helpers ─────────────────────────────────────────────────────────────

async function writeSidecarDrive(folderId, filename, json) {
  const blob = new Blob([json], { type: 'application/json' })
  await uploadDriveFile(folderId, new File([blob], sidecarFileName(filename), { type: 'application/json' }))
}

// ── Main hook ─────────────────────────────────────────────────────────────────

export function useAutonomousMode({ sourceDir, destDir, threshold }) {
  const [enabled,        setEnabled]        = useState(false)
  const [phase,          setPhase]          = useState('idle')
  const [processedCount, setProcessedCount] = useState(0)
  const [skippedCount,   setSkippedCount]   = useState(0)
  const [newArrivals,    setNewArrivals]     = useState(0)
  const [lastPollAt,     setLastPollAt]      = useState(null)
  const [errors,         setErrors]          = useState([])

  const processedFilenames = useRef(new Set())
  const writableSourceRef  = useRef(null)   // readwrite FSAPI handle (local only)
  const pollTimerRef       = useRef(null)
  const cancelledRef       = useRef(false)

  const addError = useCallback((msg) => setErrors(prev => [...prev, msg]), [])

  // ── Score + export a batch of { id, filename, file } objects ──────────────

  const processBatch = useCallback(async (items) => {
    if (!items.length) return

    setPhase('scoring')
    let results
    let rankingErrors = []
    try {
      ;({ results, rankingErrors } = await rankPhotos(items))
    } catch (err) {
      addError(`Scoring failed: ${err.message}`)
      return
    }

    for (const e of rankingErrors) {
      addError(`Could not score ${e.filename || e.id}: ${e.detail || 'unknown error'}`)
    }
    const resultMap = Object.fromEntries(results.map((r) => [r.id, r]))
    for (const item of items) {
      if (!resultMap[item.id]) processedFilenames.current.add(item.filename)
    }

    if (!results.length) {
      if (!rankingErrors.length) addError('No images could be scored in this batch.')
      return
    }

    // Keep Culling / Review UI in sync with scores from this run (same as “Begin AI scoring”).
    useStore.getState().batchUpdateScores(results)
    const isDriveDest   = !!destDir?._drive
    const isDriveSource = !!sourceDir?._drive

    setPhase('exporting')
    let exported = 0
    let skipped  = 0

    const exportTasks = items.map(item => async () => {
      if (cancelledRef.current) return
      const r = resultMap[item.id]
      if (!r) return

      const scoreOk =
        typeof r.overall_score === 'number' && Number.isFinite(r.overall_score)
          ? r.overall_score >= threshold
          : false
      // Backend: is_burst_best true for solos and for highest score in each burst group
      const burstOk = r.is_burst_best !== false
      const qualifies = scoreOk && burstOk

      if (qualifies) {
        try {
          if (isDriveDest) {
            await uploadDriveFile(destDir.folderId, item.file)
          } else if (destDir) {
            await exportFileLocal(destDir, item.file, item.filename)
          }
          exported++
        } catch (err) {
          addError(`Export failed for ${item.filename}: ${err.message}`)
        }
      } else {
        skipped++
      }

      // Write sidecar to source folder regardless of export outcome
      const sidecarJson = JSON.stringify(
        buildSidecarPayload({ filename: item.filename, result: r, threshold, exported: qualifies }),
        null,
        2,
      )
      try {
        if (isDriveSource) {
          await writeSidecarDrive(sourceDir.folderId, item.filename, sidecarJson)
        } else if (writableSourceRef.current) {
          await writeSidecarLocal(writableSourceRef.current, item.filename, sidecarJson)
        }
      } catch (err) {
        addError(`Sidecar write failed for ${item.filename}: ${err.message}`)
      }
      // Always mark processed in memory — even if sidecar write failed — to
      // avoid re-scoring in the same session
      processedFilenames.current.add(item.filename)
    })

    // Process file I/O concurrently in chunks of 10 to speed up exports and sidecar writes
    for (let i = 0; i < exportTasks.length; i += 10) {
      if (cancelledRef.current) break
      await Promise.all(exportTasks.slice(i, i + 10).map(task => task()))
    }

    setProcessedCount(c => c + exported)
    setSkippedCount(c => c + skipped)
  }, [sourceDir, destDir, threshold, addError])

  // ── Build the list of unprocessed images from a Drive folder ─────────────
  // Uses mode=all to get both images and existing .bbp.json sidecars in one
  // round-trip, so sidecar detection works correctly.

  async function fetchDriveUnprocessed(folderId) {
    const listing = await browseDrive(folderId, 'all')
    const allFiles = listing.items || []

    // Split into sidecar names (Set) and image files
    const existingSidecars = new Set(
      allFiles.filter(f => f.name.endsWith(SIDECAR_SUFFIX)).map(f => f.name)
    )
    const imageFiles = allFiles.filter(
      f => !f.name.endsWith(SIDECAR_SUFFIX)
    )

    const filesToDownload = []
    for (const f of imageFiles) {
      if (processedFilenames.current.has(f.name)) continue
      if (existingSidecars.has(sidecarFileName(f.name))) {
        // Already processed in a previous session
        processedFilenames.current.add(f.name)
        continue
      }
      filesToDownload.push(f)
    }

    const unprocessed = []
    // Process downloads in chunks of 10
    for (let i = 0; i < filesToDownload.length; i += 10) {
      if (cancelledRef.current) break
      const chunk = filesToDownload.slice(i, i + 10)
      const chunkResults = await Promise.all(chunk.map(async (f) => {
        try {
          const file = await downloadDriveFile(f.id, { name: f.name, mimeType: f.mimeType })
          const ext = file.name.split('.').pop().toLowerCase()
          if (WEB_FORMATS.has(ext) || RAW_FORMATS.has(ext)) {
            return { id: f.id, filename: f.name, file }
          }
        } catch (err) {
          addError(`Download failed for ${f.name}: ${err.message}`)
        }
        return null
      }))

      unprocessed.push(...chunkResults.filter(Boolean))
    }
    return unprocessed
  }

  // ── Build the list of unprocessed images from a local FSAPI folder ────────

  async function fetchLocalUnprocessed() {
    const handle = writableSourceRef.current
    if (!handle) return []

    const unprocessed = []
    for await (const entry of handle.values()) {
      if (cancelledRef.current) break
      if (entry.kind !== 'file') continue
      const name = entry.name
      if (name.endsWith(SIDECAR_SUFFIX)) continue
      const ext = name.split('.').pop().toLowerCase()
      if (!WEB_FORMATS.has(ext) && !RAW_FORMATS.has(ext)) continue
      if (processedFilenames.current.has(name)) continue
      if (await sidecarExistsLocal(handle, name)) {
        processedFilenames.current.add(name)
        continue
      }
      try {
        const file = await entry.getFile()
        unprocessed.push({ id: name, filename: name, file })
      } catch (err) {
        addError(`Read failed for ${name}: ${err.message}`)
      }
    }
    return unprocessed
  }

  // Use refs for callbacks that cross-reference each other to avoid TDZ
  // issues in bundled code (self-referencing consts can trip Rollup/Vite).
  const pollRef = useRef(null)
  const initialLoadRef = useRef(null)

  // ── Initial load ──────────────────────────────────────────────────────────

  initialLoadRef.current = async () => {
    setPhase('loading')
    let items = []
    try {
      items = sourceDir._drive
        ? await fetchDriveUnprocessed(sourceDir.folderId)
        : await fetchLocalUnprocessed()
    } catch (err) {
      addError(`Load failed: ${err.message}`)
      setEnabled(false)
      return
    }

    setNewArrivals(items.length)
    const scoreable = items.filter(i => WEB_FORMATS.has(i.filename.split('.').pop().toLowerCase()))
    for (let i = 0; i < scoreable.length; i += RANK_BATCH_SIZE) {
      if (cancelledRef.current) break
      await processBatch(scoreable.slice(i, i + RANK_BATCH_SIZE))
    }

    if (!cancelledRef.current) {
      setPhase('watching')
      setLastPollAt(new Date())
      pollTimerRef.current = setTimeout(() => pollRef.current(), POLL_INTERVAL)
    }
  }

  // ── Poll ──────────────────────────────────────────────────────────────────

  pollRef.current = async () => {
    if (cancelledRef.current) return
    setLastPollAt(new Date())

    let items = []
    try {
      items = sourceDir._drive
        ? await fetchDriveUnprocessed(sourceDir.folderId)
        : await fetchLocalUnprocessed()
    } catch (err) {
      addError(`Poll failed: ${err.message}`)
    }

    setNewArrivals(items.length)
    const scoreable = items.filter(i => WEB_FORMATS.has(i.filename.split('.').pop().toLowerCase()))
    for (let i = 0; i < scoreable.length; i += RANK_BATCH_SIZE) {
      if (cancelledRef.current) break
      await processBatch(scoreable.slice(i, i + RANK_BATCH_SIZE))
    }

    if (!cancelledRef.current) {
      setPhase('watching')
      pollTimerRef.current = setTimeout(() => pollRef.current(), POLL_INTERVAL)
    }
  }

  // ── Toggle ────────────────────────────────────────────────────────────────

  const toggle = useCallback(async () => {
    if (enabled) {
      cancelledRef.current = true
      clearTimeout(pollTimerRef.current)
      writableSourceRef.current = null
      setEnabled(false)
      setPhase('idle')
      return
    }

    // Validate prerequisites
    if (!sourceDir || sourceDir._ios) {
      addError('Autonomous mode requires a folder source, not individual files.')
      return
    }
    if (!destDir) {
      addError('Select an export folder before enabling autonomous mode.')
      return
    }

    // ── Drive source: acquire write scope NOW (user-gesture context) ─────────
    // DO NOT defer this to processBatch() — browsers block OAuth popups from
    // timer/poll callbacks. The toggle click handler is the only safe place.
    if (sourceDir._drive || destDir._drive) {
      try {
        await ensureDriveWriteSession()
      } catch (err) {
        addError(`Google Drive write access is required for sidecar files: ${err.message}`)
        return
      }
    }

    // ── Local source: upgrade handle to readwrite for sidecar writing ─────────
    if (!sourceDir._drive) {
      try {
        const canRequestPermission = typeof sourceDir.requestPermission === 'function'
        if (canRequestPermission) {
          // Chrome / Edge
          const perm = await sourceDir.requestPermission({ mode: 'readwrite' })
          if (perm !== 'granted') {
            addError('Write permission to source folder is required for sidecar files.')
            return
          }
          writableSourceRef.current = sourceDir
        } else {
          // Safari: requestPermission() not supported — re-pick with readwrite mode.
          // The browser will ask the user to confirm the same folder.
          const dir = await window.showDirectoryPicker({ mode: 'readwrite' })
          writableSourceRef.current = dir
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          addError(`Could not get write access to source folder: ${err.message}`)
        }
        return
      }
    }

    cancelledRef.current = false
    setEnabled(true)
    setErrors([])
    setProcessedCount(0)
    setSkippedCount(0)
    setNewArrivals(0)
    processedFilenames.current = new Set()

    initialLoadRef.current()
  }, [enabled, sourceDir, destDir, addError])

  // Cleanup on unmount
  useEffect(() => () => {
    cancelledRef.current = true
    clearTimeout(pollTimerRef.current)
  }, [])

  // Disable when source or dest changes
  useEffect(() => {
    if (!enabled) return
    cancelledRef.current = true
    clearTimeout(pollTimerRef.current)
    writableSourceRef.current = null
    setEnabled(false)
    setPhase('idle')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceDir, destDir])

  const canEnable = !!sourceDir && !sourceDir._ios && !!destDir

  return { enabled, phase, processedCount, skippedCount, newArrivals, lastPollAt, errors, toggle, canEnable }
}
