import { useEffect, useCallback, useState, useMemo } from 'react'
import { useStore } from '../store'
import { usePhotoLoader } from '../hooks/usePhotoLoader'
import { usePhotoRanker } from '../hooks/usePhotoRanker'
import { useSessionPersistence } from '../hooks/useSessionPersistence'

function MetricRow({ label, score }) {
  const pct = Math.round(score * 100)
  const color = pct >= 75 ? 'bg-secondary' : pct >= 50 ? 'bg-tertiary' : 'bg-error'
  return (
    <div className="flex items-center gap-2">
      <span className="text-on-surface-variant w-16 shrink-0" style={{ fontSize: '9px' }}>{label}</span>
      <div className="flex-1 h-0.5 bg-surface-container-highest overflow-hidden">
        <div className={`h-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-on-surface w-6 text-right font-mono" style={{ fontSize: '9px' }}>{pct}</span>
    </div>
  )
}

function AIScoreBadge({ photo }) {
  const overall = Math.round((photo.overallScore ?? 0) * 100)
  const overallColor = overall >= 75 ? 'text-secondary' : overall >= 50 ? 'text-tertiary' : 'text-error'
  const subj = photo.subject
  const comp = photo.composition
  const hasFace = subj && subj.face_count > 0
  const blinkDetected = hasFace && subj.eyes_open === false
  const horizonAngle = comp?.horizon_angle ?? 0
  const tiltWarning = comp && Math.abs(horizonAngle) >= 2.0

  return (
    <div
      className="flex flex-col gap-2 px-4 py-3 border border-primary/20 min-w-44"
      style={{ background: 'rgba(26,26,26,0.85)', backdropFilter: 'blur(20px)' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary" style={{ fontSize: '14px', fontVariationSettings: "'FILL' 1" }}>auto_awesome</span>
          <span className="text-on-surface-variant tracking-widest font-bold" style={{ fontSize: '9px' }}>AI SCORE</span>
        </div>
        <span className={`font-display font-extrabold text-xl leading-none ${overallColor}`}>{overall}</span>
      </div>

      {/* Warnings */}
      {blinkDetected && (
        <div className="flex items-center gap-1.5 bg-error/15 px-2 py-1">
          <span className="material-symbols-outlined text-error" style={{ fontSize: '11px', fontVariationSettings: "'FILL' 1" }}>visibility_off</span>
          <span className="text-error font-bold tracking-widest" style={{ fontSize: '9px' }}>BLINK DETECTED</span>
        </div>
      )}
      {tiltWarning && (
        <div className="flex items-center gap-1.5 bg-tertiary/10 px-2 py-1">
          <span className="material-symbols-outlined text-tertiary" style={{ fontSize: '11px', fontVariationSettings: "'FILL' 1" }}>straighten</span>
          <span className="text-tertiary font-bold tracking-widest" style={{ fontSize: '9px' }}>
            HORIZON {horizonAngle > 0 ? '+' : ''}{horizonAngle.toFixed(1)}°
          </span>
        </div>
      )}

      {/* Divider */}
      <div className="h-px bg-outline-variant/20" />

      {/* Per-metric rows */}
      <div className="flex flex-col gap-1.5">
        <MetricRow label="FOCUS"       score={photo.sharpness ?? 0} />
        <MetricRow label="EXPOSURE"    score={photo.exposure?.exposure_score ?? 0} />
        <MetricRow label="NOISE"       score={photo.noise?.noise_score ?? 0} />
        <MetricRow label="CONTRAST"    score={photo.contrast?.contrast_score ?? 0} />
        {hasFace && (
          <MetricRow label="SUBJECT"   score={subj.subject_score ?? 0} />
        )}
        {comp && (
          <MetricRow label="COMPOSIT." score={comp.composition_score ?? 0} />
        )}
      </div>

      {/* Face count indicator */}
      {hasFace && (
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="material-symbols-outlined text-primary/60" style={{ fontSize: '10px', fontVariationSettings: "'FILL' 1" }}>face</span>
          <span className="text-on-surface-variant/60" style={{ fontSize: '9px' }}>
            {subj.face_count} face{subj.face_count !== 1 ? 's' : ''} · eyes {subj.eyes_open ? 'open' : 'closed'}
          </span>
        </div>
      )}
    </div>
  )
}

function DecisionButton({ label, shortcut, icon, color, onClick, active }) {
  const colorMap = {
    keep: {
      icon: active ? 'bg-secondary text-on-secondary' : 'bg-secondary/15 text-secondary hover:bg-secondary/25',
      text: 'text-secondary',
    },
    maybe: {
      icon: active ? 'bg-tertiary text-on-tertiary' : 'bg-tertiary/10 text-tertiary hover:bg-tertiary/20',
      text: 'text-tertiary',
    },
    reject: {
      icon: active ? 'bg-error text-on-error' : 'bg-error/10 text-error hover:bg-error/20',
      text: 'text-error',
    },
  }
  const c = colorMap[color]
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center gap-2 transition-all duration-150 ${active ? 'scale-110' : 'opacity-70 hover:opacity-100'}`}
    >
      <div className={`w-10 h-10 flex items-center justify-center transition-colors ${c.icon}`}>
        <span className="material-symbols-outlined" style={{ fontSize: '22px', fontVariationSettings: "'wght' 300" }}>{icon}</span>
      </div>
      <div className="flex flex-col items-center gap-0.5">
        <span className={`font-bold tracking-widest ${c.text}`} style={{ fontSize: '9px' }}>{label}</span>
        <span className="text-on-surface-variant/40" style={{ fontSize: '9px' }}>[{shortcut}]</span>
      </div>
    </button>
  )
}

// Stable palette of 8 burst group colours (cycles for groups > 8)
const BURST_COLORS = [
  '#69daff', '#a8edce', '#ffb74d', '#ce93d8',
  '#ef9a9a', '#80cbc4', '#fff176', '#90caf9',
]

function burstColor(groupId) {
  return BURST_COLORS[(groupId - 1) % BURST_COLORS.length]
}

function FilmstripThumb({ photo, isActive, onClick }) {
  const decisionDot = {
    keep: 'bg-secondary',
    maybe: 'bg-tertiary',
    reject: 'bg-error',
  }
  const hasBurst = photo.burstGroup != null

  return (
    <div
      onClick={onClick}
      className={`flex-shrink-0 cursor-pointer overflow-hidden relative transition-all duration-200 ${
        isActive
          ? 'w-20 h-20 border-2 border-primary ring-4 ring-primary/20 z-10 mx-1'
          : 'w-16 h-16 opacity-40 hover:opacity-80 border border-transparent'
      }`}
    >
      {photo.url ? (
        <img src={photo.url} alt="" className="w-full h-full object-cover" />
      ) : (
        <div className="w-full h-full bg-surface-container-high flex items-center justify-center">
          <span className="material-symbols-outlined text-on-surface-variant" style={{ fontSize: '20px' }}>photo</span>
        </div>
      )}
      {/* Burst group colour bar along the bottom */}
      {hasBurst && (
        <div
          className="absolute bottom-0 left-0 right-0 h-1"
          style={{ background: burstColor(photo.burstGroup) }}
        />
      )}
      {/* Best-in-burst star */}
      {hasBurst && photo.isBurstBest && (
        <div className="absolute top-1 left-1">
          <span
            className="material-symbols-outlined"
            style={{ fontSize: '11px', fontVariationSettings: "'FILL' 1", color: burstColor(photo.burstGroup) }}
          >star</span>
        </div>
      )}
      {photo.decision && (
        <div className={`absolute top-1 right-1 w-2 h-2 rounded-full ${decisionDot[photo.decision]}`} />
      )}
    </div>
  )
}

const FILTER_METRICS = [
  { key: 'overall',     label: 'OVERALL SCORE', path: p => p.overallScore },
  { key: 'focus',       label: 'FOCUS',         path: p => p.sharpness },
  { key: 'exposure',    label: 'EXPOSURE',       path: p => p.exposure?.exposure_score },
  { key: 'noise',       label: 'NOISE',          path: p => p.noise?.noise_score },
  { key: 'contrast',    label: 'CONTRAST',       path: p => p.contrast?.contrast_score },
  { key: 'subject',     label: 'SUBJECT',        path: p => p.subject?.subject_score },
  { key: 'composition', label: 'COMPOSITION',    path: p => p.composition?.composition_score },
]

function getScore(photo, metric) {
  const val = metric.path(photo)
  return val == null ? null : val
}

function meetsFilters(photo, applied) {
  for (const { key, min } of applied) {
    const metric = FILTER_METRICS.find(m => m.key === key)
    if (!metric) continue
    const score = getScore(photo, metric)
    if (score == null || score < min) return false
  }
  return true
}

function FilterPanel({ onApply, onClear, hasFilter }) {
  const [rows, setRows] = useState(
    FILTER_METRICS.map(m => ({ key: m.key, label: m.label, enabled: false, value: '70' }))
  )

  const toggle = (key) => setRows(r => r.map(row => row.key === key ? { ...row, enabled: !row.enabled } : row))
  const setValue = (key, val) => setRows(r => r.map(row => row.key === key ? { ...row, value: val } : row))

  const handleApply = () => {
    const active = rows
      .filter(r => r.enabled)
      .map(r => ({ key: r.key, min: Math.max(0, Math.min(100, parseInt(r.value, 10) || 0)) / 100 }))
    onApply(active)
  }

  return (
    <div className="border-t border-outline-variant/20 bg-surface-container px-6 py-3">
      <div className="flex items-start gap-6 flex-wrap">
        {rows.map(row => (
          <div key={row.key} className="flex items-center gap-2">
            <button
              onClick={() => toggle(row.key)}
              className={`w-4 h-4 flex items-center justify-center border transition-colors ${
                row.enabled ? 'bg-primary border-primary' : 'border-outline-variant/40 bg-transparent'
              }`}
            >
              {row.enabled && <span className="material-symbols-outlined text-surface-container" style={{ fontSize: '11px', fontVariationSettings: "'FILL' 1" }}>check</span>}
            </button>
            <span className="text-on-surface-variant tracking-widest" style={{ fontSize: '9px' }}>{row.label}</span>
            {row.enabled && (
              <div className="flex items-center gap-1">
                <span className="text-on-surface-variant/50" style={{ fontSize: '9px' }}>≥</span>
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={row.value}
                  onChange={e => setValue(row.key, e.target.value)}
                  className="w-10 bg-surface-container-high border border-outline-variant/30 text-on-surface text-center font-mono py-0.5 outline-none focus:border-primary"
                  style={{ fontSize: '10px' }}
                />
                <span className="text-on-surface-variant/50" style={{ fontSize: '9px' }}>%</span>
              </div>
            )}
          </div>
        ))}

        <div className="flex items-center gap-2 ml-auto">
          {hasFilter && (
            <button
              onClick={() => { setRows(r => r.map(row => ({ ...row, enabled: false }))); onClear() }}
              className="text-on-surface-variant/60 hover:text-on-surface-variant tracking-widest transition-colors"
              style={{ fontSize: '9px' }}
            >
              CLEAR
            </button>
          )}
          <button
            onClick={handleApply}
            className="bg-primary text-surface-container px-4 py-1.5 font-bold tracking-widest transition-opacity hover:opacity-80"
            style={{ fontSize: '9px' }}
          >
            APPLY FILTER
          </button>
        </div>
      </div>
    </div>
  )
}

export default function CullingView() {
  const { loading, loadingComplete, loadedCount, totalCount: scanTotal, loadError } = usePhotoLoader()
  const { scoring, scoredCount, backendAvailable } = usePhotoRanker(loadingComplete)
  useSessionPersistence(loadingComplete)

  const authSessionExpired = useStore(state => state.authSessionExpired)
  const photos = useStore(state => state.photos)
  const order = useStore(state => state.order)
  const currentId = useStore(state => state.currentId)
  const setCurrentId = useStore(state => state.setCurrentId)
  const makeDecision = useStore(state => state.makeDecision)
  const undoDecision = useStore(state => state.undo)
  const history = useStore(state => state.history)

  const [showFilters, setShowFilters] = useState(false)
  const [appliedFilters, setAppliedFilters] = useState([]) // [{key, min}]

  const filteredOrder = useMemo(() => {
    if (appliedFilters.length === 0) return order
    return order.filter(id => meetsFilters(photos[id], appliedFilters))
  }, [order, photos, appliedFilters])

  const currentPhoto = photos[currentId]
  const currentIndex = filteredOrder.indexOf(currentId)
  const totalCount = filteredOrder.length
  const keepCount = Object.values(photos).filter(p => p.decision === 'keep').length
  const sessionPct = totalCount > 0 ? Math.round((keepCount / totalCount) * 100) : 0

  const goNext = useCallback(() => {
    if (currentIndex < filteredOrder.length - 1) setCurrentId(filteredOrder[currentIndex + 1])
  }, [currentIndex, filteredOrder, setCurrentId])

  const goPrev = useCallback(() => {
    if (currentIndex > 0) setCurrentId(filteredOrder[currentIndex - 1])
  }, [currentIndex, filteredOrder, setCurrentId])

  const decide = useCallback((decision) => {
    if (currentId) {
      makeDecision(currentId, decision)
      goNext()
    }
  }, [currentId, makeDecision, goNext])

  const undo = useCallback(() => {
    if (history.length === 0) return
    const lastId = history[history.length - 1].id
    undoDecision()
    setCurrentId(lastId)
  }, [history, undoDecision, setCurrentId])

  useEffect(() => {
    const handleKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      if (e.key === 'p' || e.key === 'P') decide('keep')
      else if (e.key === 'u' || e.key === 'U') decide('maybe')
      else if (e.key === 'x' || e.key === 'X') decide('reject')
      else if (e.key === 'ArrowRight') goNext()
      else if (e.key === 'ArrowLeft') goPrev()
      else if ((e.key === 'z' || e.key === 'Z') && !e.metaKey && !e.ctrlKey) undo()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [decide, goNext, goPrev, undo])

  // Loading state — show progress while scanning/reading files
  if (loading && order.length === 0) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-6 bg-surface-container-lowest">
        <span className="material-symbols-outlined text-primary/40 animate-pulse" style={{ fontSize: '64px' }}>photo_library</span>
        <div className="text-center">
          <p className="text-on-surface-variant tracking-widest text-xs font-bold mb-2">LOADING PHOTOS</p>
          {scanTotal > 0 ? (
            <p className="text-primary font-display font-bold text-2xl">{loadedCount} / {scanTotal}</p>
          ) : (
            <p className="text-on-surface-variant text-sm">Scanning folder...</p>
          )}
        </div>
        {scanTotal > 0 && (
          <div className="w-48 h-1 bg-surface-container-highest overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-300"
              style={{ width: `${Math.round((loadedCount / scanTotal) * 100)}%` }}
            />
          </div>
        )}
      </div>
    )
  }

  // Error state
  if (loadError) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-4 bg-surface-container-lowest">
        <span className="material-symbols-outlined text-error" style={{ fontSize: '48px' }}>error_outline</span>
        <p className="text-on-surface-variant text-sm tracking-wider">Failed to load photos</p>
        <p className="text-error/70 text-xs font-mono">{loadError}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-surface-container-lowest">

      {/* Main area: photo + right action column */}
      <div className="flex flex-1 min-h-0">

        {/* Photo viewer */}
        <div className="flex-1 relative overflow-hidden bg-black">

          {/* Photo */}
          {currentPhoto?.url ? (
            <img
              src={currentPhoto.url}
              alt={currentPhoto.filename || ''}
              className="w-full h-full object-contain"
            />
          ) : currentPhoto?.isRaw ? (
            <div className="w-full h-full flex flex-col items-center justify-center gap-4">
              <span className="material-symbols-outlined text-on-surface-variant/30" style={{ fontSize: '72px' }}>raw_on</span>
              <div className="text-center">
                <p className="text-on-surface-variant text-sm tracking-wider">{currentPhoto.filename}</p>
                <p className="text-on-surface-variant/40 text-xs mt-2 tracking-wide">RAW preview requires backend processing</p>
              </div>
            </div>
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center gap-4">
              <span className="material-symbols-outlined text-on-surface-variant/30" style={{ fontSize: '72px' }}>photo_library</span>
              <div className="text-center">
                <p className="text-on-surface-variant text-sm tracking-wider">NO PHOTOS LOADED</p>
                <p className="text-on-surface-variant/40 text-xs mt-2 tracking-wide">Select a source folder to begin culling</p>
              </div>
            </div>
          )}

          {/* Top-left: AI Score badge */}
          <div className="absolute top-6 left-6 flex flex-col gap-2 z-10">
            {currentPhoto?.overallScore != null ? (
              <AIScoreBadge photo={currentPhoto} />
            ) : scoring && !currentPhoto?.isRaw ? (
              <div
                className="flex items-center gap-2 px-4 py-2 border border-outline-variant/20"
                style={{ background: 'rgba(38,38,38,0.75)', backdropFilter: 'blur(20px)' }}
              >
                <span className="material-symbols-outlined text-on-surface-variant/50 animate-pulse" style={{ fontSize: '16px' }}>auto_awesome</span>
                <p className="text-on-surface-variant/50 tracking-widest" style={{ fontSize: '9px' }}>ANALYZING…</p>
              </div>
            ) : null}
          </div>

          {/* Bottom-left: filename + focus status */}
          {currentPhoto && (
            <div className="absolute bottom-6 left-6 z-10">
              <p className="text-on-surface text-sm font-medium tracking-wider">{currentPhoto.filename || currentPhoto.id}</p>
              {currentPhoto.focusStatus && (
                <p className="text-on-surface-variant text-xs tracking-wider mt-1">{currentPhoto.focusStatus}</p>
              )}
            </div>
          )}

          {/* Bottom-right: burst badge */}
          {currentPhoto?.burstGroup != null && (
            <div
              className="absolute bottom-6 right-6 z-10 flex items-center gap-2 px-3 py-1.5"
              style={{ background: 'rgba(26,26,26,0.85)', backdropFilter: 'blur(20px)', borderLeft: `3px solid ${burstColor(currentPhoto.burstGroup)}` }}
            >
              <span
                className="material-symbols-outlined"
                style={{ fontSize: '13px', fontVariationSettings: "'FILL' 1", color: burstColor(currentPhoto.burstGroup) }}
              >{currentPhoto.isBurstBest ? 'star' : 'burst_mode'}</span>
              <div className="flex flex-col gap-0.5">
                <span className="font-bold tracking-widest" style={{ fontSize: '9px', color: burstColor(currentPhoto.burstGroup) }}>
                  {currentPhoto.isBurstBest ? 'BEST IN BURST' : `BURST GROUP ${currentPhoto.burstGroup}`}
                </span>
                <span className="text-on-surface-variant/60 tracking-widest" style={{ fontSize: '9px' }}>
                  {currentPhoto.burstSize} SIMILAR FRAMES
                </span>
              </div>
            </div>
          )}

          {/* Nav arrows */}
          <button
            onClick={goPrev}
            disabled={currentIndex <= 0}
            className="absolute left-3 top-1/2 -translate-y-1/2 w-10 h-10 flex items-center justify-center text-on-surface/30 hover:text-on-surface/80 disabled:opacity-0 transition-all z-10"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '36px' }}>chevron_left</span>
          </button>
          <button
            onClick={goNext}
            disabled={currentIndex >= filteredOrder.length - 1}
            className="absolute right-3 top-1/2 -translate-y-1/2 w-10 h-10 flex items-center justify-center text-on-surface/30 hover:text-on-surface/80 disabled:opacity-0 transition-all z-10"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '36px' }}>chevron_right</span>
          </button>
        </div>

        {/* Right action column */}
        <div className="w-20 shrink-0 flex flex-col items-center justify-center gap-6 bg-surface-container-low border-l border-outline-variant/20">
          <DecisionButton
            label="KEEP"
            shortcut="P"
            icon="check"
            color="keep"
            onClick={() => decide('keep')}
            active={currentPhoto?.decision === 'keep'}
          />
          <DecisionButton
            label="MAYBE"
            shortcut="U"
            icon="star"
            color="maybe"
            onClick={() => decide('maybe')}
            active={currentPhoto?.decision === 'maybe'}
          />
          <DecisionButton
            label="REJECT"
            shortcut="X"
            icon="close"
            color="reject"
            onClick={() => decide('reject')}
            active={currentPhoto?.decision === 'reject'}
          />
        </div>
      </div>

      {/* Bottom strip */}
      <div className="shrink-0 border-t border-outline-variant/20 bg-surface-container-low">

        {/* Stats bar */}
        <div className="flex items-center justify-between px-6 py-2">
          <div className="flex flex-col gap-1 min-w-32">
            <span className="text-on-surface-variant tracking-widest" style={{ fontSize: '9px', fontWeight: 600 }}>SESSION HEALTH</span>
            <div className="w-24 h-1 bg-surface-container-highest overflow-hidden">
              <div className="h-full bg-primary transition-all duration-500" style={{ width: `${sessionPct}%` }} />
            </div>
            <span className="text-on-surface-variant tracking-wider" style={{ fontSize: '9px' }}>{sessionPct}% SELECTED</span>
          </div>

          <div className="text-center">
            <div className="text-on-surface-variant tracking-widest" style={{ fontSize: '10px' }}>
              {totalCount > 0 ? `${currentIndex + 1} / ${totalCount} IMAGES` : 'NO IMAGES'}
            </div>
            {appliedFilters.length > 0 && (
              <div className="text-primary/70 tracking-widest mt-0.5" style={{ fontSize: '9px' }}>
                FILTERED · {totalCount} OF {order.length}
              </div>
            )}
          </div>

          <div className="flex items-center gap-3">
            {/* Undo */}
            <button
              onClick={undo}
              disabled={history.length === 0}
              title="Undo last decision [Z]"
              className="flex items-center gap-1 text-on-surface-variant/50 hover:text-on-surface-variant disabled:opacity-20 transition-colors"
            >
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>undo</span>
              <span className="tracking-widest" style={{ fontSize: '9px' }}>UNDO [Z]</span>
            </button>

            <div className="w-px h-4 bg-outline-variant/30" />

            {/* Backend / scoring status */}
            {scoring && (
              <span className="text-primary/60 tracking-widest animate-pulse" style={{ fontSize: '9px' }}>
                SCORING {scoredCount}/{totalCount}
              </span>
            )}
            {authSessionExpired && (
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="text-error tracking-widest hover:underline"
                style={{ fontSize: '9px' }}
              >
                SESSION EXPIRED · RELOAD
              </button>
            )}
            {!authSessionExpired && !backendAvailable && (
              <span className="text-error/60 tracking-widest" style={{ fontSize: '9px' }}>
                BACKEND OFFLINE
              </span>
            )}
            <button className="text-on-surface-variant/50 hover:text-on-surface-variant transition-colors">
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>zoom_in</span>
            </button>
            <button className="text-on-surface-variant/50 hover:text-on-surface-variant transition-colors">
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>grid_view</span>
            </button>
            <button
              onClick={() => setShowFilters(v => !v)}
              className={`relative transition-colors ${showFilters || appliedFilters.length > 0 ? 'text-primary' : 'text-on-surface-variant/50 hover:text-on-surface-variant'}`}
            >
              <span className="material-symbols-outlined" style={{ fontSize: '18px', fontVariationSettings: showFilters ? "'FILL' 1" : "'FILL' 0" }}>tune</span>
              {appliedFilters.length > 0 && (
                <span className="absolute -top-1 -right-1 w-3 h-3 bg-primary text-surface-container flex items-center justify-center font-bold" style={{ fontSize: '7px' }}>
                  {appliedFilters.length}
                </span>
              )}
            </button>
          </div>
        </div>

        {/* Filter panel */}
        {showFilters && (
          <FilterPanel
            onApply={(filters) => {
              setAppliedFilters(filters)
              // Jump to first matching photo if current is excluded
              if (filters.length > 0) {
                const first = order.find(id => meetsFilters(photos[id], filters))
                if (first && !meetsFilters(photos[currentId], filters)) setCurrentId(first)
              }
            }}
            onClear={() => setAppliedFilters([])}
            hasFilter={appliedFilters.length > 0}
          />
        )}

        {/* Filmstrip */}
        <div className="h-24 flex items-center gap-1 px-4 overflow-x-auto no-scrollbar border-t border-outline-variant/10">
          {filteredOrder.length === 0 ? (
            <div className="flex-1 flex items-center justify-center">
              <span className="text-on-surface-variant/30 text-xs tracking-wider">
                {appliedFilters.length > 0 ? 'No photos match the current filters' : 'Filmstrip will appear here'}
              </span>
            </div>
          ) : (
            filteredOrder.map(id => (
              <FilmstripThumb
                key={id}
                photo={photos[id]}
                isActive={id === currentId}
                onClick={() => setCurrentId(id)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}
