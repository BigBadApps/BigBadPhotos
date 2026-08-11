import { useState, useEffect, useCallback, useMemo } from 'react'
import { useStore } from '../store'
import Icon from '../components/Icon'
import DecisionBadge from '../components/DecisionBadge'

// MetadataHUD to display details about the active photo
function MetadataHUD({ photo }) {
  if (!photo) return null;
  const overallScore = photo.overallScore ?? photo.sharpness ?? null;
  return (
    <div style={{
      position: 'absolute', top: 16, left: 16,
      padding: 12,
      background: 'rgba(0,0,0,.65)',
      backdropFilter: 'blur(12px)',
      border: '1px solid rgba(255,255,255,.08)',
      borderRadius: 8,
      pointerEvents: 'none', zIndex: 10,
    }}>
      <p className="meta" style={{ marginBottom: 8 }}>Metadata</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px' }}>
        <span className="fs-xs dim">File</span>
        <span className="fs-xs mono" style={{ color: 'var(--fg-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '16ch' }} title={photo.filename}>
          {photo.filename}
        </span>
        {overallScore != null && (
          <>
            <span className="fs-xs dim">Quality</span>
            <span className="fs-xs mono" style={{ color: 'var(--accent)', fontWeight: 600 }}>
              {Math.round(overallScore * 100)}/100
            </span>
          </>
        )}
        {photo.sharpness != null && (
          <>
            <span className="fs-xs dim">Sharpness</span>
            <span className="fs-xs mono" style={{ color: 'var(--fg-2)' }}>
              {Math.round(photo.sharpness * 100)}
            </span>
          </>
        )}
        {photo.burstGroup && (
          <>
            <span className="fs-xs dim">Burst</span>
            <span className="fs-xs mono" style={{ color: 'var(--warning)' }}>
              #{photo.burstGroup} {photo.isBurstBest ? '★' : ''}
            </span>
          </>
        )}
      </div>
    </div>
  )
}

function DecisionDock({ decision, decide, undo, canUndo }) {
  const items = [
    { kind: 'reject', label: 'Reject', icon: 'x', color: 'var(--reject)' },
    { kind: 'maybe',  label: 'Maybe',  icon: 'qmark', color: 'var(--maybe)' },
    { kind: 'keep',   label: 'Keep',   icon: 'check', color: 'var(--keep)' },
  ];
  return (
    <div style={{
      position: 'absolute', bottom: 24, left: '50%', transform: 'translateX(-50%)',
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '10px 18px',
      background: 'rgba(14,14,14,.88)',
      backdropFilter: 'blur(20px)',
      border: '1px solid rgba(255,255,255,.08)',
      borderRadius: 12,
      zIndex: 10,
    }}>
      <button
        type="button"
        onClick={undo}
        disabled={!canUndo}
        style={{
          width: 38, height: 38, borderRadius: 8,
          background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.1)',
          display: 'grid', placeItems: 'center',
          color: canUndo ? 'var(--fg-2)' : 'var(--fg-4)',
          cursor: canUndo ? 'pointer' : 'not-allowed', transition: 'all .15s',
        }}
        title="Undo (⌘Z)"
      >
        <Icon name="undo" size={14} />
      </button>
      {items.map(({ kind, label, icon, color }) => {
        const isActive = decision === kind;
        return (
          <button
            key={kind}
            type="button"
            onClick={() => decide(kind)}
            style={{
              height: 38, borderRadius: 8, padding: '0 16px',
              background: isActive ? color : 'rgba(255,255,255,.05)',
              border: `1px solid ${isActive ? color : 'rgba(255,255,255,.1)'}`,
              display: 'flex', alignItems: 'center', gap: 8,
              cursor: 'pointer', transition: 'all .12s var(--ease-out)',
              color: isActive ? '#0c0c0e' : 'var(--fg-2)',
              fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)',
              textTransform: 'uppercase', letterSpacing: '.04em', fontWeight: 600,
              boxShadow: isActive ? `0 0 14px color-mix(in oklab, ${color} 40%, transparent)` : 'none',
            }}
          >
            <Icon name={icon} size={14} stroke={2.2} />
            {label}
          </button>
        );
      })}
    </div>
  );
}

export default function CompareView() {
  const photos = useStore(state => state.photos)
  const order = useStore(state => state.order)
  const makeDecision = useStore(state => state.makeDecision)
  const history = useStore(state => state.history)
  const undo = useStore(state => state.undo)

  const [selectedStackIndex, setSelectedStackIndex] = useState(0)
  const [isStackOpen, setIsStackOpen] = useState(false)
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState(0)

  // Group photos by capture time windows (within 30 seconds of each other)
  const stacks = useMemo(() => {
    // 1. Get all photos and sort them chronologically by file.lastModified, using filename as a tie-breaker
    const sortedPhotos = order
      .map((id) => photos[id])
      .filter(Boolean)
      .sort((a, b) => {
        const timeA = a.file?.lastModified ?? 0;
        const timeB = b.file?.lastModified ?? 0;
        if (timeA !== timeB) return timeA - timeB;
        return a.filename.localeCompare(b.filename);
      });

    if (sortedPhotos.length === 0) return [];

    const grouped = [];
    let currentStack = [sortedPhotos[0]];
    const TIME_GAP_THRESHOLD_MS = 30 * 1000; // 30 seconds gap

    for (let i = 1; i < sortedPhotos.length; i++) {
      const prevPhoto = sortedPhotos[i - 1];
      const currPhoto = sortedPhotos[i];
      const prevTime = prevPhoto.file?.lastModified ?? 0;
      const currTime = currPhoto.file?.lastModified ?? 0;

      // Group photos if the time gap between consecutive photos is <= 30 seconds
      if (prevTime > 0 && currTime > 0 && (currTime - prevTime) <= TIME_GAP_THRESHOLD_MS) {
        currentStack.push(currPhoto);
      } else {
        grouped.push(currentStack);
        currentStack = [currPhoto];
      }
    }
    if (currentStack.length > 0) {
      grouped.push(currentStack);
    }

    // 2. Process stacks: sort photos inside each stack by overallScore (or sharpness) descending
    return grouped.map((groupPhotos, index) => {
      groupPhotos.sort((a, b) => {
        const scoreA = a.overallScore ?? a.sharpness ?? 0;
        const scoreB = b.overallScore ?? b.sharpness ?? 0;
        return scoreB - scoreA;
      });
      return {
        key: `stack:${index}:${groupPhotos[0].id}`,
        photos: groupPhotos,
        isBurst: groupPhotos.length > 1,
      };
    });
  }, [order, photos]);

  const clampedStackIndex = Math.min(selectedStackIndex, Math.max(0, stacks.length - 1))
  const currentStack = stacks[clampedStackIndex]
  const clampedPhotoIndex = currentStack ? Math.min(selectedPhotoIndex, Math.max(0, currentStack.photos.length - 1)) : 0
  const activePhoto = currentStack?.photos[clampedPhotoIndex]

  const activeStackPhotosCount = currentStack?.photos.length ?? 0

  const goNext = useCallback(() => {
    if (isStackOpen) {
      setSelectedPhotoIndex((prev) => Math.min(prev + 1, activeStackPhotosCount - 1))
    } else {
      setSelectedStackIndex((prev) => Math.min(prev + 1, stacks.length - 1))
      setSelectedPhotoIndex(0)
    }
  }, [isStackOpen, activeStackPhotosCount, stacks.length])

  const goPrev = useCallback(() => {
    if (isStackOpen) {
      setSelectedPhotoIndex((prev) => Math.max(prev - 1, 0))
    } else {
      setSelectedStackIndex((prev) => Math.max(prev - 1, 0))
      setSelectedPhotoIndex(0)
    }
  }, [isStackOpen])

  const decide = useCallback((kind) => {
    if (activePhoto) {
      makeDecision(activePhoto.id, kind)
    }
  }, [activePhoto, makeDecision])

  // Swipe gesture hooks for mobile
  const [touchStart, setTouchStart] = useState(null)
  const [touchEnd, setTouchEnd] = useState(null)
  const minSwipeDistance = 50

  const handleTouchStart = (e) => {
    setTouchEnd(null)
    setTouchStart(e.targetTouches[0].clientX)
  }

  const handleTouchMove = (e) => {
    setTouchEnd(e.targetTouches[0].clientX)
  }

  const handleTouchEnd = () => {
    if (!touchStart || !touchEnd) return
    const distance = touchStart - touchEnd
    const isLeftSwipe = distance > minSwipeDistance
    const isRightSwipe = distance < -minSwipeDistance
    if (isLeftSwipe) {
      goNext()
    } else if (isRightSwipe) {
      goPrev()
    }
  }

  const handleSelectStack = (index) => {
    setSelectedStackIndex(index)
    setSelectedPhotoIndex(0)
    setIsStackOpen(true)
  }

  useEffect(() => {
    const handle = (e) => {
      if (e.target.tagName === 'INPUT') return
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        goNext()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        goPrev()
      } else if (e.key === 'Escape' || e.key === 'Backspace') {
        setIsStackOpen(false)
      } else if (activePhoto) {
        if (e.key === '1' || e.key === 'p' || e.key === 'P') {
          makeDecision(activePhoto.id, 'keep')
        } else if (e.key === '2' || e.key === 'm' || e.key === 'M') {
          makeDecision(activePhoto.id, 'maybe')
        } else if (e.key === '3' || e.key === 'r' || e.key === 'R') {
          makeDecision(activePhoto.id, 'reject')
        } else if (e.key === 'u' || e.key === 'U' || (e.key === 'z' && (e.metaKey || e.ctrlKey))) {
          undo()
        }
      }
    }
    window.addEventListener('keydown', handle)
    return () => window.removeEventListener('keydown', handle)
  }, [goNext, goPrev, activePhoto, makeDecision, undo])

  if (order.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', alignItems: 'center', justifyContent: 'center', gap: 16, background: 'var(--bg)' }}>
        <Icon name="image" size={56} style={{ color: 'var(--fg-4)' }} />
        <p className="fs-sm" style={{ color: 'var(--fg-3)' }}>No photos loaded</p>
        <p className="meta">Load photos in Cull first</p>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg)' }}>

      {/* Control HUD */}
      <div style={{
        flexShrink: 0,
        borderBottom: '1px solid var(--line)',
        padding: '10px var(--sp-5)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        background: 'color-mix(in oklab, var(--bg) 90%, transparent)',
        backdropFilter: 'blur(20px)', zIndex: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '4px 10px', borderRadius: 6,
            background: 'var(--bg-3)', border: '1px solid var(--line)',
          }}>
            <Icon name="swipe" size={14} style={{ color: 'var(--fg-3)' }} />
            <span className="meta">{isStackOpen ? 'Reviewing Stack' : 'Overview Stacks'}</span>
          </div>
          <span className="meta" style={{ color: 'var(--fg-4)' }}>
            [1/P] Keep · [2/M] Maybe · [3/R] Reject · [←/→] Navigate · {isStackOpen ? '[ESC] Back' : '[Click Stack] Open'}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="meta" style={{ padding: '4px 10px', background: 'var(--bg-3)', border: '1px solid var(--line)', borderRadius: 6 }}>
            {isStackOpen ? (
              <>Stack {clampedStackIndex + 1} &middot; Image {clampedPhotoIndex + 1} / {activeStackPhotosCount}</>
            ) : (
              <>Stack {clampedStackIndex + 1} / {stacks.length}</>
            )}
          </span>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              onClick={goPrev}
              disabled={isStackOpen ? clampedPhotoIndex === 0 : clampedStackIndex === 0}
              className="iconbtn"
              style={{
                color: (isStackOpen ? clampedPhotoIndex === 0 : clampedStackIndex === 0) ? 'var(--fg-4)' : 'var(--fg-2)',
                cursor: (isStackOpen ? clampedPhotoIndex === 0 : clampedStackIndex === 0) ? 'not-allowed' : 'pointer'
              }}
            >
              <Icon name="arrowL" size={16} />
            </button>
            <button
              onClick={goNext}
              disabled={isStackOpen ? clampedPhotoIndex >= activeStackPhotosCount - 1 : clampedStackIndex >= stacks.length - 1}
              className="iconbtn"
              style={{
                color: (isStackOpen ? clampedPhotoIndex >= activeStackPhotosCount - 1 : clampedStackIndex >= stacks.length - 1) ? 'var(--fg-4)' : 'var(--fg-2)',
                cursor: (isStackOpen ? clampedPhotoIndex >= activeStackPhotosCount - 1 : clampedStackIndex >= stacks.length - 1) ? 'not-allowed' : 'pointer'
              }}
            >
              <Icon name="arrowR" size={16} />
            </button>
          </div>
        </div>
      </div>

      {/* Main Single-Image View */}
      <div 
        style={{ display: 'flex', flex: 1, minHeight: 0, background: '#000', position: 'relative', overflow: 'hidden' }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {activePhoto ? (
          <>
            {activePhoto.url ? (
              <img
                key={activePhoto.id}
                src={activePhoto.url}
                alt={activePhoto.filename}
                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
              />
            ) : (
              <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
                <Icon name="image" size={48} style={{ color: 'var(--fg-4)' }} />
                <p className="fs-xs meta">{activePhoto.filename}</p>
              </div>
            )}
            
            <MetadataHUD photo={activePhoto} />

            {activePhoto.decision && (
              <div style={{ position: 'absolute', top: 16, right: 16, zIndex: 10 }}>
                <DecisionBadge kind={activePhoto.decision} />
              </div>
            )}

            <DecisionDock
              decision={activePhoto.decision}
              decide={decide}
              undo={undo}
              canUndo={history.length > 0}
            />
          </>
        ) : (
          <div style={{ display: 'flex', width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }}>
            <span className="meta">No photo selected</span>
          </div>
        )}
      </div>

      {/* Filmstrip / Stacks Selector */}
      <div style={{
        flexShrink: 0, height: 96,
        borderTop: '1px solid var(--line)',
        background: 'var(--bg-2)',
        display: 'flex', alignItems: 'center', gap: 16,
        padding: '0 var(--pad)', overflowX: 'auto',
      }}>
        {isStackOpen && currentStack ? (
          <>
            <button
              onClick={() => setIsStackOpen(false)}
              className="btn btn-ghost btn-uppercase"
              style={{
                height: 48, padding: '0 12px', fontSize: 'var(--fs-xxs)',
                display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0
              }}
            >
              <Icon name="arrowL" size={14} />
              Stacks
            </button>

            <div style={{ display: 'flex', gap: 8, overflowX: 'auto', flex: 1, alignItems: 'center' }}>
              {currentStack.photos.map((photo, i) => {
                const isSelected = i === clampedPhotoIndex;
                const overall = photo.overallScore ?? photo.sharpness ?? null;
                return (
                  <div
                    key={photo.id}
                    onClick={() => setSelectedPhotoIndex(i)}
                    style={{
                      flexShrink: 0, width: 80, height: 64,
                      overflow: 'hidden', cursor: 'pointer',
                      position: 'relative', borderRadius: 6,
                      border: isSelected
                        ? '2px solid var(--accent)'
                        : '1px solid var(--line)',
                      opacity: isSelected ? 1 : .55,
                      transition: 'all .2s var(--ease-out)',
                    }}
                  >
                    {photo.url ? (
                      <img src={photo.url} alt={photo.filename} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : (
                      <div style={{ width: '100%', height: '100%', background: 'var(--bg-3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <Icon name="image" size={18} style={{ color: 'var(--fg-4)' }} />
                      </div>
                    )}
                    {overall != null && (
                      <div style={{
                        position: 'absolute', top: 2, right: 2,
                        background: 'rgba(0,0,0,.6)', color: 'var(--accent)', fontSize: 9,
                        fontFamily: 'var(--font-mono)', padding: '1px 3px', borderRadius: 3
                      }}>
                        {Math.round(overall * 100)}
                      </div>
                    )}
                    {photo.decision && (
                      <div style={{
                        position: 'absolute', bottom: 0, left: 0, right: 0, height: 3,
                        background: photo.decision === 'keep' ? 'var(--keep)' : photo.decision === 'reject' ? 'var(--reject)' : 'var(--maybe)',
                      }} />
                    )}
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div style={{ display: 'flex', gap: 16, overflowX: 'auto', flex: 1, alignItems: 'center', height: '100%' }}>
            {stacks.map((stack, i) => {
              const isSelected = i === clampedStackIndex;
              const topPhoto = stack.photos[0];
              const overall = topPhoto?.overallScore ?? topPhoto?.sharpness ?? null;
              return (
                <button
                  type="button"
                  key={stack.key}
                  onClick={() => handleSelectStack(i)}
                  aria-label={`Stack ${i + 1}${stack.photos.length > 1 ? ` (${stack.photos.length} photos)` : ''}`}
                  aria-pressed={isSelected}
                  style={{
                    flexShrink: 0,
                    width: 80,
                    height: 64,
                    cursor: 'pointer',
                    position: 'relative',
                    transition: 'transform .2s var(--ease-out)',
                    border: 'none',
                    background: 'transparent',
                    padding: 0,
                    display: 'block',
                    font: 'inherit',
                  }}
                >
                  {/* Overlapping stack layers visual effect */}
                  {stack.photos.length > 2 && (
                    <div style={{
                      position: 'absolute', top: -5, left: 5, right: -5, bottom: 5,
                      background: 'var(--bg-3)', border: '1px solid var(--line)', borderRadius: 6, zIndex: 1,
                      opacity: 0.7
                    }} />
                  )}
                  {stack.photos.length > 1 && (
                    <div style={{
                      position: 'absolute', top: -2.5, left: 2.5, right: -2.5, bottom: 2.5,
                      background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 6, zIndex: 2,
                      opacity: 0.9
                    }} />
                  )}
                  <div style={{
                    position: 'absolute', inset: 0, zIndex: 3,
                    borderRadius: 6, overflow: 'hidden',
                    border: isSelected
                      ? '2px solid var(--accent)'
                      : '1px solid var(--line)',
                    background: 'var(--bg-3)',
                  }}>
                    {topPhoto?.url ? (
                      <img src={topPhoto.url} alt={topPhoto.filename} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : (
                      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <Icon name="image" size={18} style={{ color: 'var(--fg-4)' }} />
                      </div>
                    )}
                    {overall != null && (
                      <div style={{
                        position: 'absolute', top: 2, right: 2,
                        background: 'rgba(0,0,0,.6)', color: 'var(--accent)', fontSize: 9,
                        fontFamily: 'var(--font-mono)', padding: '1px 3px', borderRadius: 3
                      }}>
                        {Math.round(overall * 100)}
                      </div>
                    )}
                    {topPhoto?.decision && (
                      <div style={{
                        position: 'absolute', bottom: 0, left: 0, right: 0, height: 3,
                        background: topPhoto.decision === 'keep' ? 'var(--keep)' : topPhoto.decision === 'reject' ? 'var(--reject)' : 'var(--maybe)',
                      }} />
                    )}
                  </div>
                  {stack.photos.length > 1 && (
                    <span style={{
                      position: 'absolute', bottom: 4, right: 4, zIndex: 4,
                      background: 'rgba(0,0,0,.8)', color: '#fff', fontSize: 9,
                      padding: '1px 5px', borderRadius: 4, fontFamily: 'var(--font-mono)', fontWeight: 600
                    }}>
                      {stack.photos.length}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  )
}
