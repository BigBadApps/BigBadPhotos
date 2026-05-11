import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store'
import { createDisplayUrl } from '../utils/imageResize'

const WEB_FORMATS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp'])
const RAW_FORMATS = new Set(['raw', 'arw', 'cr2', 'cr3', 'nef', 'dng', 'orf', 'rw2', 'raf', 'tif', 'tiff'])
const HAS_DIR_PICKER = typeof window !== 'undefined' && 'showDirectoryPicker' in window

// ── Stat card used in desktop bottom row ──────────────────────────────────────
function StatCard({ label, value, unit, sub, subColor }) {
  return (
    <div className="bg-surface-container-lowest border border-white/5 p-6 flex flex-col">
      <span className="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-[0.2em] mb-4">{label}</span>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-black text-on-surface tracking-tighter">{value}</span>
        {unit && <span className="text-xs font-bold text-on-surface-variant/60 uppercase">{unit}</span>}
      </div>
      {sub && (
        <span className={`text-[10px] mt-4 font-mono uppercase tracking-tighter ${subColor || 'text-on-surface-variant/40'}`}>
          {sub}
        </span>
      )}
    </div>
  )
}

export default function LandingView() {
  const navigate     = useNavigate()
  const setSourceDir = useStore(s => s.setSourceDir)
  const setDestDir   = useStore(s => s.setDestDir)
  const clearPhotos  = useStore(s => s.clearPhotos)
  const addPhotos    = useStore(s => s.addPhotos)
  const setCurrentId = useStore(s => s.setCurrentId)
  const sourceDir    = useStore(s => s.sourceDir)
  const destDir      = useStore(s => s.destDir)
  const photos       = useStore(s => s.photos)
  const order        = useStore(s => s.order)
  const scoringProgress = useStore(s => s.scoringProgress)
  const isScoring    = useStore(s => s.isScoring)
  const authSessionExpired = useStore(s => s.authSessionExpired)

  const [error, setError]         = useState(null)
  const [iosLoading, setIosLoading] = useState(false)
  const [showStatus, setShowStatus] = useState(false)
  const [health, setHealth]         = useState(null)
  const fileInputRef = useRef(null)

  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch('/health', { signal: AbortSignal.timeout(4000) })
        setHealth(res.ok)
      } catch { setHealth(false) }
    }
    check()
    const id = setInterval(check, 30000)
    return () => clearInterval(id)
  }, [])

  // ── Derived state ────────────────────────────────────────────────────────────
  const photoCount  = order.length
  const firstPhoto  = photoCount > 0 ? photos[order[0]] : null
  const rawCount    = Object.values(photos).filter(p => p.isRaw).length
  const webCount    = photoCount - rawCount
  const fileTypeTag = rawCount > 0 ? 'RAW' : photoCount > 0 ? 'IMG' : null
  const heroSrc     = firstPhoto?.url ?? '/eagle-placeholder.jpg'
  const heroName    = firstPhoto
    ? firstPhoto.filename.replace(/\.[^.]+$/, '').toUpperCase()
    : 'IMPERIAL_EAGLE_RAW_01'

  const scoredCount = scoringProgress.done
  const scoreTotal  = scoringProgress.total
  const scorePct    = scoreTotal > 0 ? Math.round((scoredCount / scoreTotal) * 100) : 0
  const scoringLabel = photoCount === 0
    ? '0 of 0 images'
    : scoreTotal > 0
      ? `${scoredCount.toLocaleString()} of ${scoreTotal.toLocaleString()} scored`
      : webCount === 0
        ? 'RAW only — no web scores'
        : 'Awaiting analysis'

  const sourceName = sourceDir
    ? (sourceDir._ios ? `${photoCount} photos loaded` : sourceDir.name)
    : null
  const destName = destDir ? destDir.name : null

  const sourceSelected = !!sourceDir
  const destSelected   = !!destDir

  // ── Folder pickers ───────────────────────────────────────────────────────────
  const handleSourcePicker = async () => {
    try {
      const h = await window.showDirectoryPicker()
      clearPhotos(); setSourceDir(h); setError(null)
    } catch (err) { if (err.name !== 'AbortError') setError(err.message) }
  }

  const handleDestPicker = async () => {
    try {
      const h = await window.showDirectoryPicker({ mode: 'readwrite' })
      setDestDir(h); setError(null)
    } catch (err) { if (err.name !== 'AbortError') setError(err.message) }
  }

  // ── iOS file input ────────────────────────────────────────────────────────────
  const handleFileInput = async (e) => {
    const files = Array.from(e.target.files)
    if (!files.length) return
    setIosLoading(true); setError(null); clearPhotos()
    try {
      const eligible = files
        .filter(f => { const x = f.name.split('.').pop().toLowerCase(); return WEB_FORMATS.has(x) || RAW_FORMATS.has(x) })
        .sort((a, b) => a.name.localeCompare(b.name))

      const loaded = (await Promise.all(eligible.map(async (file) => {
        const ext = file.name.split('.').pop().toLowerCase()
        const isWeb = WEB_FORMATS.has(ext)
        let url = null
        if (isWeb) { try { url = await createDisplayUrl(file) } catch { url = null } }
        return { id: file.name, filename: file.name, url, file, isRaw: !isWeb, decision: null, rank: null, sharpness: null }
      }))).filter(Boolean)

      addPhotos(loaded)
      setSourceDir({ name: `ios-${eligible.length}-photos`, _ios: true })
      if (loaded.length > 0) setCurrentId(loaded[0].id)
      navigate('/cull')
    } catch (err) { setError(`Failed to load photos: ${err.message}`) }
    finally { setIosLoading(false) }
  }

  const canBegin = !!sourceDir && !iosLoading

  // ═══════════════════════════════════════════════════════════════════════════
  // MOBILE layout  (< md)
  // ═══════════════════════════════════════════════════════════════════════════
  const mobileLayout = (
    <div className="md:hidden flex flex-col h-full bg-surface">

      {/* Top bar — cog always visible; title/back only after source selected */}
      <header className="flex items-center justify-between px-4 h-14 bg-surface shrink-0 z-10">
        {sourceDir ? (
          <div className="flex items-center gap-3">
            <button className="p-2 hover:bg-surface-container-highest transition-colors active:scale-95">
              <span className="material-symbols-outlined text-primary" style={{ fontSize: '22px' }}>arrow_back</span>
            </button>
            <h1 className="text-base font-black text-primary-container uppercase tracking-tighter">
              REVIEW &amp; EXPORT
            </h1>
          </div>
        ) : <div />}
        <button
          onClick={() => setShowStatus(true)}
          className="p-2 hover:bg-surface-container-highest transition-colors active:scale-95"
        >
          <span
            className="material-symbols-outlined"
            style={{ fontSize: '22px', color: health === null ? '#9ccee2' : health ? '#00d1ff' : '#ffb4ab' }}
          >
            settings
          </span>
        </button>
      </header>

      {/* System status modal */}
      {showStatus && (
        <div className="fixed inset-0 z-50 flex items-end justify-center" onClick={() => setShowStatus(false)}>
          <div
            className="w-full bg-surface-container-lowest border-t border-outline-variant/20 p-6 space-y-4"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-black uppercase tracking-widest text-on-surface-variant">SYSTEM STATUS</span>
              <button onClick={() => setShowStatus(false)}>
                <span className="material-symbols-outlined text-on-surface-variant/60" style={{ fontSize: '20px' }}>close</span>
              </button>
            </div>
            <div className="flex items-center gap-3">
              <span
                className="inline-block w-2 h-2 rounded-full"
                style={{ background: health === null ? '#9ccee2' : health ? '#00d1ff' : '#ffb4ab' }}
              />
              <span
                className="text-sm font-bold tracking-widest uppercase"
                style={{ color: health === null ? '#9ccee2' : health ? '#00d1ff' : '#ffb4ab' }}
              >
                {health === null ? 'CHECKING…' : health ? 'ONLINE' : 'OFFLINE'}
              </span>
            </div>
            <p className="text-[10px] text-on-surface-variant/40 tracking-widest uppercase">
              BIGBADPHOTOS · SCORING ENGINE
            </p>
          </div>
        </div>
      )}

      {/* Hero */}
      <section className="relative w-full bg-surface-container-lowest overflow-hidden shrink-0" style={{ aspectRatio: '4/5' }}>
        <img
          src={heroSrc}
          alt="Current selection"
          className="w-full h-full object-cover object-top"
          style={{ filter: firstPhoto ? 'none' : 'grayscale(0.3) brightness(0.75)' }}
        />
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'linear-gradient(to top, #131313 0%, transparent 55%)' }} />
        {firstPhoto && (
          <div className="absolute bottom-0 left-0 w-full p-5 flex items-end justify-between">
            <div>
              <p className="text-[10px] font-bold tracking-[0.2em] text-secondary uppercase mb-1">CURRENT SELECTION</p>
              <h2 className="text-xl font-extrabold tracking-tighter text-on-surface uppercase truncate max-w-[200px]">
                {heroName}
              </h2>
            </div>
            <div className="text-right shrink-0">
              {firstPhoto.overallScore != null && (
                <span className="block text-[10px] font-bold text-primary-container uppercase tracking-widest">
                  SCORE {Math.round(firstPhoto.overallScore * 100)}
                </span>
              )}
              {firstPhoto.exposure?.exposure_score != null && (
                <span className="block text-[10px] font-bold text-secondary uppercase tracking-widest">
                  EXP {Math.round(firstPhoto.exposure.exposure_score * 100)}%
                </span>
              )}
            </div>
          </div>
        )}
      </section>

      {/* Controls */}
      <section className="flex-1 overflow-y-auto px-4 py-6 space-y-4">

        {/* Source */}
        <button
          onClick={HAS_DIR_PICKER ? handleSourcePicker : () => fileInputRef.current?.click()}
          disabled={iosLoading}
          className="group w-full flex items-center justify-between p-5 bg-surface-container hover:bg-surface-container-highest transition-all duration-200 border-l-2 border-primary-container"
        >
          <div className="flex flex-col items-start text-left">
            <span className="text-[10px] font-bold text-secondary uppercase tracking-widest mb-1">SELECT AN IMAGE SOURCE FOLDER</span>
            <span className={`text-sm font-semibold truncate max-w-[220px] ${sourceSelected ? 'text-primary-container' : 'text-on-surface-variant/50'}`}>
              {sourceName ?? 'IMAGE SOURCE DIRECTORY'}
            </span>
          </div>
          <span className="material-symbols-outlined text-primary-container group-hover:translate-x-1 transition-transform" style={{ fontSize: '22px' }}>
            folder_open
          </span>
        </button>

        {/* Dest */}
        <button
          onClick={HAS_DIR_PICKER ? handleDestPicker : undefined}
          disabled={!HAS_DIR_PICKER}
          className={`group w-full flex items-center justify-between p-5 bg-surface-container transition-all duration-200 border-l-2 border-secondary ${HAS_DIR_PICKER ? 'hover:bg-surface-container-highest cursor-pointer' : 'cursor-default'}`}
        >
          <div className="flex flex-col items-start text-left">
            <span className="text-[10px] font-bold text-secondary uppercase tracking-widest mb-1">SELECT AN IMAGE EXPORT FOLDER</span>
            <span className={`text-sm font-semibold truncate max-w-[220px] ${destSelected ? 'text-secondary' : 'text-on-surface-variant/50'}`}>
              {destName ?? (HAS_DIR_PICKER ? 'SELECT EXPORT FOLDER' : 'IOS SHARE SHEET ON EXPORT')}
            </span>
          </div>
          <span className="material-symbols-outlined text-secondary group-hover:translate-x-1 transition-transform" style={{ fontSize: '22px' }}>
            drive_file_move
          </span>
        </button>

        {authSessionExpired && (
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="w-full bg-error/15 border border-error/40 text-error text-[10px] font-bold tracking-widest uppercase py-3 px-4"
          >
            Session expired · reload to sign in
          </button>
        )}

        {/* Stats */}
        <div className="flex justify-between items-start pt-2">
          <div className="space-y-1">
            <p className="text-[10px] font-bold text-secondary uppercase tracking-widest">Detected Assets</p>
            <p className="text-4xl font-black text-on-surface tracking-tighter">
              {photoCount > 0 ? photoCount.toLocaleString() : '—'}
              {fileTypeTag && <span className="text-primary-container text-sm ml-2">{fileTypeTag}</span>}
            </p>
          </div>
          <div className="bg-surface-container-highest p-4 flex flex-col items-end">
            <p className="text-[10px] font-bold text-secondary uppercase tracking-widest mb-2">Scoring Progress</p>
            <div className="w-24 h-1 bg-surface-container-low">
              <div
                className="h-full bg-primary-container transition-all duration-500"
                style={{ width: `${scoreTotal > 0 ? scorePct : 0}%` }}
              />
            </div>
            <p className="text-[10px] font-bold text-on-surface mt-1">{scoringLabel}</p>
          </div>
        </div>

        {error && (
          <div className="bg-error/10 border-l-2 border-error px-4 py-3">
            <p className="text-error text-sm">{error}</p>
          </div>
        )}

        {/* CTA */}
        <button
          onClick={() => canBegin && navigate('/cull')}
          disabled={!canBegin}
          className={`group relative w-full py-6 flex items-center justify-center gap-3 overflow-hidden transition-all duration-100 active:scale-[0.98] ${
            canBegin ? 'bg-primary-container active:brightness-125' : 'bg-surface-container cursor-not-allowed'
          }`}
        >
          <span className={`font-black tracking-[0.2em] uppercase text-sm relative z-10 ${canBegin ? 'text-on-primary' : 'text-on-surface-variant'}`}>
            {iosLoading ? 'LOADING…' : 'BEGIN REVIEW'}
          </span>
          {canBegin && (
            <span className="material-symbols-outlined text-on-primary relative z-10 group-hover:translate-x-2 transition-transform" style={{ fontSize: '20px', fontVariationSettings: "'FILL' 1" }}>
              play_arrow
            </span>
          )}
          {canBegin && (
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-700" />
          )}
        </button>

        {!canBegin && !iosLoading && (
          <p className="text-center text-[10px] text-secondary/40 uppercase tracking-widest leading-relaxed pt-2">
            SELECT AN IMAGE SOURCE FOLDER AND AN IMAGE EXPORT FOLDER THEN BEGIN REVIEW
          </p>
        )}

        <div className="h-4" />
      </section>

      {!HAS_DIR_PICKER && (
        <input ref={fileInputRef} type="file" webkitdirectory="" className="hidden" onChange={handleFileInput} />
      )}
    </div>
  )

  // ═══════════════════════════════════════════════════════════════════════════
  // TABLET layout  (md → lg)  — sidebar provided by Sidebar.jsx
  // ═══════════════════════════════════════════════════════════════════════════
  const sharedControls = (
    <div className="flex flex-col gap-5">

      {authSessionExpired && (
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="w-full bg-error/15 border border-error/40 text-error text-[10px] font-bold tracking-widest uppercase py-3 px-4 hover:bg-error/25 transition-colors text-center"
        >
          Session expired · reload to sign in
        </button>
      )}

      {/* Source card */}
      <button
        onClick={HAS_DIR_PICKER ? handleSourcePicker : () => fileInputRef.current?.click()}
        disabled={iosLoading}
        className="group w-full bg-surface-container-high border-l-2 border-primary-container p-5 text-left hover:bg-surface-container-highest transition-all"
      >
        <div className="flex items-center justify-between mb-3">
          <span className="text-[11px] font-black uppercase tracking-widest text-primary-container">SELECT AN IMAGE SOURCE FOLDER</span>
          {sourceSelected
            ? <span className="material-symbols-outlined text-primary-container" style={{ fontSize: '18px', fontVariationSettings: "'FILL' 1" }}>check_circle</span>
            : <span className="material-symbols-outlined text-primary-container" style={{ fontSize: '18px' }}>folder_open</span>
          }
        </div>
        <div className={`bg-surface-container-lowest px-3 py-2 font-mono text-xs break-all ${sourceName ? 'text-secondary' : 'text-on-surface-variant/40'}`}>
          {sourceName ?? 'IMAGE SOURCE DIRECTORY'}
        </div>
        {firstPhoto && (
          <div className="flex items-center gap-2 pt-3 border-t border-outline-variant/10 mt-3">
            <span className="material-symbols-outlined text-primary" style={{ fontSize: '16px' }}>raw_on</span>
            <span className="text-sm font-bold tracking-tight truncate">{firstPhoto.filename}</span>
          </div>
        )}
      </button>

      {/* Export card */}
      <button
        onClick={HAS_DIR_PICKER ? handleDestPicker : undefined}
        disabled={!HAS_DIR_PICKER}
        className={`group w-full bg-surface-container border-l-2 border-outline-variant p-5 text-left transition-all ${HAS_DIR_PICKER ? 'hover:bg-surface-container-high cursor-pointer' : 'cursor-default'}`}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="text-[11px] font-black uppercase tracking-widest text-on-surface-variant">SELECT AN IMAGE EXPORT FOLDER</span>
          <span className="material-symbols-outlined text-on-surface-variant" style={{ fontSize: '18px' }}>
            {destSelected ? 'check_circle' : 'edit_note'}
          </span>
        </div>
        <div className={`bg-surface-container-lowest px-3 py-2 font-mono text-xs break-all ${destName ? 'text-secondary/70' : 'text-on-surface-variant/40'}`}>
          {destName ?? (HAS_DIR_PICKER ? 'SELECT EXPORT FOLDER' : 'IOS SHARE SHEET ON EXPORT')}
        </div>
      </button>

      {/* Stats bento */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-surface-container-low p-4 space-y-1">
          <p className="text-[10px] text-secondary/40 font-bold uppercase tracking-widest">Total Assets</p>
          <p className="text-xl font-black text-on-surface">{photoCount > 0 ? photoCount.toLocaleString() : '—'}</p>
        </div>
        <div className="bg-surface-container-low p-4 space-y-1">
          <p className="text-[10px] text-secondary/40 font-bold uppercase tracking-widest">Scored</p>
          <p className="text-xl font-black text-on-surface">
            {scoreTotal > 0 ? `${scorePct}%` : photoCount > 0 ? (webCount > 0 ? '—' : 'RAW') : '—'}
          </p>
        </div>
      </div>

      {error && (
        <div className="bg-error/10 border-l-2 border-error px-4 py-3">
          <p className="text-error text-sm">{error}</p>
        </div>
      )}

      {/* CTA */}
      <div className="mt-auto pt-4">
        <button
          onClick={() => canBegin && navigate('/cull')}
          disabled={!canBegin}
          className={`group relative w-full py-6 flex items-center justify-center gap-4 overflow-hidden transition-all active:scale-[0.98] ${
            canBegin ? 'bg-primary-container hover:brightness-110' : 'bg-surface-container cursor-not-allowed'
          }`}
        >
          <span className={`font-black text-sm uppercase tracking-[0.2em] relative z-10 ${canBegin ? 'text-on-primary' : 'text-on-surface-variant'}`}>
            {iosLoading ? 'LOADING…' : 'BEGIN REVIEW'}
          </span>
          {canBegin && (
            <span className="material-symbols-outlined text-on-primary relative z-10 group-hover:translate-x-1 transition-transform" style={{ fontSize: '20px' }}>
              arrow_forward_ios
            </span>
          )}
          {canBegin && (
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-700" />
          )}
        </button>
        {!canBegin && !iosLoading && (
          <p className="text-center mt-3 text-[10px] text-secondary/40 uppercase tracking-widest leading-relaxed">
            SELECT AN IMAGE SOURCE FOLDER AND AN IMAGE EXPORT FOLDER THEN BEGIN REVIEW
          </p>
        )}
      </div>

      {!HAS_DIR_PICKER && (
        <input ref={fileInputRef} type="file" webkitdirectory="" className="hidden" onChange={handleFileInput} />
      )}
    </div>
  )

  // Tablet + Desktop (md+)
  const desktopLayout = (
    <div className="hidden md:flex flex-col h-full bg-surface overflow-hidden">

      {/* Content grid */}
      <div className="flex-1 grid grid-cols-12 gap-0 overflow-hidden">

        {/* Hero — 8 cols on lg, full width on md */}
        <section className="col-span-12 lg:col-span-8 relative bg-surface-container-lowest overflow-hidden flex items-center justify-center border-r border-outline-variant/10">
          <div className="relative w-full h-full group">
            <img
              src={heroSrc}
              alt="Current selection"
              className="w-full h-full object-cover object-top transition-all duration-700 group-hover:scale-[1.02]"
              style={{
                filter: firstPhoto ? 'grayscale(0.1) brightness(0.85)' : 'grayscale(0.3) brightness(0.75)',
              }}
            />
            <div className="absolute inset-0 pointer-events-none" style={{ background: 'linear-gradient(180deg, rgba(19,19,19,0) 40%, rgba(19,19,19,0.92) 100%)' }} />

            {/* Hero overlay — only shown after source is selected */}
            {firstPhoto && (
            <div className="absolute bottom-0 left-0 p-8 w-full flex justify-between items-end">
              <div>
                <div className="flex items-center gap-3 mb-1">
                  <span className="px-2 py-1 bg-primary-container text-on-primary text-[10px] font-black tracking-tighter uppercase">
                    CURRENT ASSET
                  </span>
                  <span className="text-on-surface-variant text-[10px] font-mono tracking-tighter uppercase">
                    {firstPhoto.filename}
                  </span>
                </div>
              </div>
              <div className="flex gap-5">
                {firstPhoto.sharpness != null && (
                  <div className="flex flex-col items-end">
                    <span className="text-[10px] text-on-surface-variant/60 font-bold uppercase">SHARP</span>
                    <span className="text-secondary font-mono text-sm">{Math.round(firstPhoto.sharpness * 100)}</span>
                  </div>
                )}
                {firstPhoto.overallScore != null && (
                  <div className="flex flex-col items-end">
                    <span className="text-[10px] text-on-surface-variant/60 font-bold uppercase">SCORE</span>
                    <span className="text-secondary font-mono text-sm">{Math.round(firstPhoto.overallScore * 100)}</span>
                  </div>
                )}
                {firstPhoto.exposure?.exposure_score != null && (
                  <div className="flex flex-col items-end">
                    <span className="text-[10px] text-on-surface-variant/60 font-bold uppercase">EXP</span>
                    <span className="text-secondary font-mono text-sm">{Math.round(firstPhoto.exposure.exposure_score * 100)}%</span>
                  </div>
                )}
              </div>
            </div>
            )}
          </div>
        </section>

        {/* Controls — 4 cols on lg, full on md */}
        <section className="col-span-12 lg:col-span-4 p-8 flex flex-col gap-0 bg-surface overflow-y-auto">
          {sharedControls}
        </section>
      </div>

      {/* Desktop bottom stats row */}
      <div className="hidden lg:grid grid-cols-4 gap-0 shrink-0 border-t border-outline-variant/10">
        <StatCard
          label="DETECTED_ASSETS"
          value={photoCount > 0 ? photoCount.toLocaleString() : '—'}
          unit={fileTypeTag ?? 'FILES'}
          sub={photoCount > 0 ? `${rawCount} RAW · ${webCount} WEB` : 'NO SOURCE LOADED'}
          subColor="text-on-surface-variant/40"
        />
        <StatCard
          label="SCORING_PROGRESS"
          value={scoreTotal > 0 ? `${scorePct}%` : '—'}
          unit="SCORED"
          sub={
            isScoring
              ? `${scoredCount} OF ${scoreTotal} ANALYZED`
              : photoCount === 0
                ? 'AWAITING SOURCE FOLDER'
                : scoreTotal > 0 && scoredCount >= scoreTotal
                  ? 'ANALYSIS COMPLETE'
                  : webCount === 0
                    ? 'RAW ONLY — NO WEB SCORES'
                    : 'AWAITING ANALYSIS'
          }
          subColor={isScoring ? 'text-primary' : 'text-on-surface-variant/40'}
        />
        <StatCard
          label="SESSION_STATUS"
          value={photoCount > 0
            ? Object.values(photos).filter(p => p.decision).length
            : '—'}
          unit={photoCount > 0 ? 'CULLED' : undefined}
          sub={photoCount > 0
            ? `${Object.values(photos).filter(p => p.decision === 'keep').length} KEEP · ${Object.values(photos).filter(p => p.decision === 'reject').length} REJECT`
            : 'NO SESSION ACTIVE'}
          subColor="text-on-surface-variant/40"
        />
        <StatCard
          label="WORKSPACE_LOAD"
          value={scoredCount > 0 ? scoredCount.toLocaleString() : '—'}
          unit={photoCount > 0 ? `OF ${photoCount.toLocaleString()} IMAGES` : undefined}
          sub={canBegin ? (scoreTotal > 0 ? `${scorePct}% ANALYZED` : 'READY TO REVIEW') : 'SELECT SOURCE FOLDER TO BEGIN'}
          subColor={canBegin ? 'text-primary' : 'text-on-surface-variant/40'}
        />
      </div>
    </div>
  )

  return (
    <>
      {mobileLayout}
      {desktopLayout}
    </>
  )
}
