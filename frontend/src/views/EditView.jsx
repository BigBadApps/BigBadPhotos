import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store'
import Icon from '../components/Icon'
import BeforeAfterViewer from '../components/BeforeAfterViewer'
import { editPhoto, editFileUrl } from '../api/editClient'
import { sidecarFileName, applyEditPatch } from '../utils/bbpSidecar'

const DEFAULT_TOGGLES = { sharpen: false, noise: false, upscale: false, lighting: false, color: false }
const TOOL_DEFS = [
  { key: 'sharpen', label: 'Sharpen' },
  { key: 'noise', label: 'Denoise' },
  { key: 'upscale', label: 'Upscale' },
  { key: 'lighting', label: 'Lighting' },
  { key: 'color', label: 'Color' },
]
// Topaz's CLI processes one file at a time — render the current keeper now,
// pre-render the next couple in the background through the same serial queue.
const PREFETCH_AHEAD = 2

function resultToEntry(result) {
  if (!result.ok) {
    return { status: 'error', error: result.detail || result.error || 'Edit failed' }
  }
  return {
    status: 'done',
    enhancements: result.enhancements,
    editedFilename: result.edited_filename,
  }
}

function ToolPill({ label, active, disabled, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        width: '100%', padding: '9px 12px', borderRadius: 8, textAlign: 'left',
        background: active ? 'color-mix(in oklab, var(--accent) 12%, transparent)' : 'var(--bg-3)',
        border: `1px solid ${active ? 'color-mix(in oklab, var(--accent) 40%, transparent)' : 'var(--line)'}`,
        color: active ? 'var(--accent)' : 'var(--fg-2)',
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'all .15s',
      }}
    >
      <span className="fs-xs mono upper">{label}</span>
      {active && <Icon name="check" size={14} />}
    </button>
  )
}

export default function EditView() {
  const navigate = useNavigate()
  const sourceDir = useStore((s) => s.sourceDir)
  const photos = useStore((s) => s.photos)
  const order = useStore((s) => s.order)
  const sourceAbsPath = useStore((s) => s.sourceAbsPath)
  const setSourceAbsPath = useStore((s) => s.setSourceAbsPath)
  const setEditResult = useStore((s) => s.setEditResult)
  const editSettings = useStore((s) => s.editSettings)

  const keepers = useMemo(
    () => order.filter((id) => photos[id]?.decision === 'keep').map((id) => photos[id]),
    [order, photos],
  )

  const [index, setIndex] = useState(0)
  const [cache, setCache] = useState({})
  const [toggles, setToggles] = useState(DEFAULT_TOGGLES)
  const [pathInput, setPathInput] = useState('')
  const [sidecarWarning, setSidecarWarning] = useState(null)

  const cacheRef = useRef({})
  const queueRef = useRef(Promise.resolve())
  const seededForId = useRef(null)
  const writableRef = useRef(null)

  const isLocal = !!sourceDir && !sourceDir._drive && !sourceDir._ios

  useEffect(() => {
    if (index > keepers.length) setIndex(keepers.length)
  }, [keepers.length, index])

  const updateEntry = useCallback((id, entry) => {
    cacheRef.current = { ...cacheRef.current, [id]: entry }
    setCache(cacheRef.current)
  }, [])

  const enqueue = useCallback((photo, enhancements) => {
    if (!photo) return Promise.resolve()
    updateEntry(photo.id, { status: 'loading' })
    queueRef.current = queueRef.current.then(async () => {
      try {
        const result = await editPhoto({
          sourceDir: sourceAbsPath,
          filename: photo.filename,
          enhancements,
          overwrite: true,
        })
        updateEntry(photo.id, resultToEntry(result))
      } catch (err) {
        updateEntry(photo.id, { status: 'error', error: err.body?.detail || err.message })
      }
    })
    return queueRef.current
  }, [sourceAbsPath, updateEntry])

  const enqueueDefault = useCallback((photo) => {
    if (!photo) return
    const existing = cacheRef.current[photo.id]
    if (existing && (existing.status === 'done' || existing.status === 'loading')) return
    enqueue(photo, undefined)
  }, [enqueue])

  // Render the current keeper, pre-render the next couple in the background.
  useEffect(() => {
    if (!sourceAbsPath || !isLocal || keepers.length === 0) return
    const last = Math.min(index + PREFETCH_AHEAD, keepers.length - 1)
    for (let i = index; i <= last; i++) enqueueDefault(keepers[i])
  }, [index, sourceAbsPath, isLocal, keepers, enqueueDefault])

  // Reset toggles when navigating to a new photo; they get seeded from the
  // backend's default render below once it completes.
  useEffect(() => {
    seededForId.current = null
    setToggles(DEFAULT_TOGGLES)
    setSidecarWarning(null)
  }, [index])

  const currentPhoto = keepers[index] || null
  const currentEntry = currentPhoto ? cache[currentPhoto.id] : null

  useEffect(() => {
    if (!currentPhoto || !currentEntry) return
    if (currentEntry.status === 'done' && currentEntry.enhancements && seededForId.current !== currentPhoto.id) {
      const e = currentEntry.enhancements
      setToggles({
        sharpen: !!e.sharpen,
        noise: !!e.noise,
        upscale: !!e.upscale,
        lighting: !!e.lighting,
        color: !!e.color,
      })
      seededForId.current = currentPhoto.id
    }
  }, [currentEntry, currentPhoto])

  const handleToggle = useCallback((key) => {
    setToggles((t) => ({ ...t, [key]: !t[key] }))
  }, [])

  const handleApply = useCallback(() => {
    if (!currentPhoto) return
    seededForId.current = currentPhoto.id // don't clobber the user's explicit choices
    enqueue(currentPhoto, toggles)
  }, [currentPhoto, toggles, enqueue])

  const handleRetry = useCallback(() => {
    if (!currentPhoto) return
    enqueue(currentPhoto, currentEntry?.enhancements)
  }, [currentPhoto, currentEntry, enqueue])

  const ensureWritable = useCallback(async () => {
    if (writableRef.current) return writableRef.current
    if (!sourceDir) return null
    try {
      if (typeof sourceDir.requestPermission === 'function') {
        const perm = await sourceDir.requestPermission({ mode: 'readwrite' })
        if (perm !== 'granted') return null
        writableRef.current = sourceDir
        return sourceDir
      }
      // Safari: requestPermission() unsupported — re-pick with readwrite mode.
      const picked = await window.showDirectoryPicker({ mode: 'readwrite' })
      writableRef.current = picked
      return picked
    } catch {
      return null
    }
  }, [sourceDir])

  const goNext = useCallback(() => {
    setIndex((i) => Math.min(i + 1, keepers.length))
  }, [keepers.length])

  const handleAccept = useCallback(async () => {
    if (!currentPhoto || !currentEntry || currentEntry.status !== 'done') { goNext(); return }
    setSidecarWarning(null)
    try {
      const dir = await ensureWritable()
      if (dir) {
        let existing = null
        try {
          const sh = await dir.getFileHandle(sidecarFileName(currentPhoto.filename))
          existing = JSON.parse(await (await sh.getFile()).text())
        } catch { /* no sidecar yet */ }
        const merged = applyEditPatch(existing, {
          filename: currentPhoto.filename,
          enhancements: currentEntry.enhancements,
          editedFilename: currentEntry.editedFilename,
        })
        const h = await dir.getFileHandle(sidecarFileName(currentPhoto.filename), { create: true })
        const w = await h.createWritable()
        await w.write(new Blob([JSON.stringify(merged, null, 2)], { type: 'application/json' }))
        await w.close()
      } else {
        setSidecarWarning('No write access to the source folder — settings were not saved to the sidecar (the edited image is still on disk in /edited).')
      }
    } catch (err) {
      setSidecarWarning(`Sidecar write failed: ${err.message}`)
    }
    setEditResult(currentPhoto.id, {
      enhancements: currentEntry.enhancements,
      editedFilename: currentEntry.editedFilename,
      acceptedAt: Date.now(),
    })
    goNext()
  }, [currentPhoto, currentEntry, ensureWritable, setEditResult, goNext])

  const handleSkip = useCallback(() => { goNext() }, [goNext])

  // ── Empty / gating states ────────────────────────────────────────────────

  if (keepers.length === 0) {
    return (
      <div className="view" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: 'var(--fg-3)' }}>
          <Icon name="sparkle" size={48} stroke={1.2} />
          <p className="fs-sm" style={{ marginTop: 12 }}>No Keepers yet.</p>
          <p className="meta" style={{ marginTop: 4 }}>Mark photos as Keep in Culling or Compare first.</p>
        </div>
      </div>
    )
  }

  if (!isLocal) {
    return (
      <div className="view" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: 'var(--fg-3)', maxWidth: '40ch' }}>
          <Icon name="lock" size={48} stroke={1.2} />
          <p className="fs-sm" style={{ marginTop: 12 }}>AI Edit runs Topaz locally and only works with a local source folder.</p>
        </div>
      </div>
    )
  }

  if (!sourceAbsPath) {
    return (
      <div className="view" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="card" style={{ width: 'min(480px, 100%)', padding: 'var(--sp-6)' }}>
          <div className="meta" style={{ marginBottom: 8 }}>AI Edit · one-time setup</div>
          <h2 style={{ margin: '0 0 8px', fontSize: 'var(--fs-lg)', fontWeight: 700 }}>Enter the source folder's path</h2>
          <p className="fs-sm" style={{ color: 'var(--fg-2)', lineHeight: 1.5, margin: '0 0 var(--sp-4)' }}>
            The browser can't reveal an absolute filesystem path, but Topaz runs on this
            Mac and needs one. Paste the absolute path to <strong>{sourceDir?.name}</strong> below
            (Finder → right-click the folder → Option → "Copy as Pathname").
          </p>
          <input
            type="text"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            placeholder="/Volumes/.../your-source-folder"
            style={{
              width: '100%', padding: '10px 12px', borderRadius: 8,
              background: 'var(--bg-3)', border: '1px solid var(--line)',
              color: 'var(--fg)', fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)',
              outline: 'none', marginBottom: 'var(--sp-4)',
            }}
          />
          <button
            type="button"
            className="btn btn-primary btn-uppercase"
            style={{ width: '100%', height: 44 }}
            disabled={!pathInput.trim()}
            onClick={() => setSourceAbsPath(pathInput.trim())}
          >
            Save &amp; Continue
          </button>
        </div>
      </div>
    )
  }

  if (index >= keepers.length) {
    const acceptedCount = keepers.filter((p) => editSettings[p.id]).length
    return (
      <div className="view" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: 'var(--fg-2)' }}>
          <Icon name="check" size={48} stroke={1.2} style={{ color: 'var(--keep)' }} />
          <p className="fs-md" style={{ marginTop: 12, fontWeight: 600 }}>All Keepers reviewed</p>
          <p className="meta" style={{ marginTop: 4 }}>{acceptedCount} of {keepers.length} edits accepted</p>
          <button
            type="button"
            className="btn btn-primary btn-uppercase"
            style={{ marginTop: 'var(--sp-5)', height: 44, padding: '0 24px' }}
            onClick={() => navigate('/review')}
          >
            Continue to Export
          </button>
        </div>
      </div>
    )
  }

  // ── Editor ────────────────────────────────────────────────────────────────

  const isLoading = !currentEntry || currentEntry.status === 'loading'
  const isError = currentEntry?.status === 'error'
  const isDone = currentEntry?.status === 'done'
  const accepted = !!editSettings[currentPhoto.id]

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Left: viewer */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--pad)', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--sp-4)' }}>
          <div>
            <div className="meta" style={{ color: 'var(--accent)', marginBottom: 4 }}>· AI Edit</div>
            <h2 style={{ margin: 0, fontSize: 'var(--fs-lg)', fontWeight: 700 }}>{currentPhoto.filename}</h2>
          </div>
          <span className="meta">{index + 1} / {keepers.length}</span>
        </div>

        <div style={{ height: 4, background: 'var(--bg-4)', borderRadius: 2, overflow: 'hidden', marginBottom: 'var(--sp-5)' }}>
          <div style={{
            height: '100%', width: `${((index) / keepers.length) * 100}%`,
            background: 'var(--accent)', borderRadius: 2, transition: 'width .3s var(--ease-out)',
          }} />
        </div>

        {isDone && (
          <BeforeAfterViewer
            originalUrl={editFileUrl(sourceAbsPath, currentPhoto.filename, 'original')}
            editedUrl={editFileUrl(sourceAbsPath, currentEntry.editedFilename, 'edited')}
          />
        )}

        {isLoading && (
          <div style={{
            aspectRatio: '3 / 2', borderRadius: 'var(--r-2)', background: 'var(--bg-2)',
            border: '1px solid var(--line)', display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 10, color: 'var(--fg-3)',
          }}>
            <Icon name="sparkle" size={32} stroke={1.2} />
            <span className="fs-xs mono upper">Rendering in Topaz…</span>
          </div>
        )}

        {isError && (
          <div style={{
            aspectRatio: '3 / 2', borderRadius: 'var(--r-2)',
            background: 'color-mix(in oklab, var(--reject) 8%, var(--bg-2))',
            border: '1px solid color-mix(in oklab, var(--reject) 30%, var(--line))',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 'var(--sp-5)',
          }}>
            <Icon name="info" size={32} style={{ color: 'var(--reject)' }} />
            <span className="fs-sm ta-c" style={{ color: 'var(--reject)' }}>{currentEntry.error}</span>
            <button type="button" className="btn btn-ghost btn-uppercase" onClick={handleRetry}>Retry</button>
          </div>
        )}

        {sidecarWarning && (
          <p className="fs-xxs" style={{ color: 'var(--warning)', marginTop: 'var(--sp-3)' }}>{sidecarWarning}</p>
        )}
      </div>

      {/* Right: tool toggles + actions */}
      <div style={{
        width: 260, flexShrink: 0, borderLeft: '1px solid var(--line)',
        background: 'var(--bg-2)', display: 'flex', flexDirection: 'column', overflowY: 'auto',
      }}>
        <div style={{ padding: 'var(--sp-5)', borderBottom: '1px solid var(--line)' }}>
          <span className="meta">Tools</span>
        </div>
        <div style={{ padding: 'var(--sp-5)', display: 'flex', flexDirection: 'column', gap: 8, borderBottom: '1px solid var(--line)' }}>
          {TOOL_DEFS.map((tool) => (
            <ToolPill
              key={tool.key}
              label={tool.label}
              active={toggles[tool.key]}
              disabled={isLoading}
              onClick={() => handleToggle(tool.key)}
            />
          ))}
          <button
            type="button"
            className="btn btn-ghost btn-uppercase"
            style={{ marginTop: 8, height: 40 }}
            disabled={isLoading}
            onClick={handleApply}
          >
            Apply
          </button>
        </div>

        <div style={{ padding: 'var(--sp-5)', marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {accepted && <p className="fs-xxs mono upper" style={{ color: 'var(--keep)', marginBottom: 2 }}>✓ Accepted</p>}
          <button
            type="button"
            className="btn btn-primary btn-uppercase"
            style={{ height: 48 }}
            disabled={!isDone}
            onClick={handleAccept}
          >
            <Icon name="check" size={16} />
            Accept
          </button>
          <button
            type="button"
            className="btn btn-quiet btn-uppercase"
            style={{ height: 40 }}
            onClick={handleSkip}
          >
            Skip
          </button>
        </div>
      </div>
    </div>
  )
}
