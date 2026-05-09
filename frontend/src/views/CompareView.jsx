import { useState, useEffect, useCallback } from 'react'
import { useStore } from '../store'
import Icon from '../components/Icon'
import DecisionBadge from '../components/DecisionBadge'

function MetadataHUD({ photo }) {
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
        <span className="fs-xs mono" style={{ color: 'var(--fg-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '12ch' }}>{photo.filename}</span>
        {photo.sharpness != null && <>
          <span className="fs-xs dim">Score</span>
          <span className="fs-xs mono" style={{ color: 'var(--accent)', fontWeight: 600 }}>{Math.round(photo.sharpness * 100)}</span>
        </>}
      </div>
    </div>
  )
}

function PhotoPanel({ photo, side, isBestMatch, onKeep, onReject }) {
  if (!photo) {
    return (
      <section style={{
        flex: 1, background: 'var(--bg-2)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        position: 'relative',
      }}>
        <span className="meta">No photo</span>
      </section>
    )
  }

  return (
    <section className="compare-panel" style={{ flex: 1, background: '#000', overflow: 'hidden', position: 'relative' }}>
      {photo.url ? (
        <img
          src={photo.url}
          alt={photo.filename}
          className="compare-img"
          style={{ width: '100%', height: '100%', objectFit: 'contain', opacity: .9, transition: 'opacity .2s' }}
        />
      ) : (
        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
          <Icon name="image" size={48} style={{ color: 'var(--fg-4)' }} />
          <p className="fs-xs meta">{photo.filename}</p>
        </div>
      )}

      <div style={{ position: 'absolute', top: 16, left: 76, zIndex: 10 }}>
        <span className="meta" style={{ color: 'var(--fg-4)' }}>{side === 'left' ? 'A' : 'B'}</span>
      </div>

      <MetadataHUD photo={photo} />

      {photo.decision && (
        <div style={{ position: 'absolute', top: 16, right: 16, zIndex: 10 }}>
          <DecisionBadge kind={photo.decision} />
        </div>
      )}

      {isBestMatch && (
        <div style={{
          position: 'absolute', top: 16, left: '50%', transform: 'translateX(-50%)',
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '5px 12px',
          background: 'color-mix(in oklab, var(--accent) 15%, transparent)',
          backdropFilter: 'blur(12px)',
          border: '1px solid color-mix(in oklab, var(--accent) 30%, transparent)',
          borderRadius: 999, zIndex: 10,
        }}>
          <Icon name="sparkle" size={12} style={{ color: 'var(--accent)' }} />
          <span className="meta" style={{ color: 'var(--accent)' }}>Best Match</span>
        </div>
      )}

      <div className="compare-actions" style={{
        position: 'absolute', bottom: 24, left: '50%', transform: 'translateX(-50%)',
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 18px',
        background: 'rgba(14,14,14,.88)',
        backdropFilter: 'blur(20px)',
        border: '1px solid rgba(255,255,255,.08)',
        borderRadius: 12,
        opacity: 0, transition: 'opacity .2s var(--ease-out)',
        whiteSpace: 'nowrap', zIndex: 10,
      }}>
        <button
          onClick={onKeep}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '6px 14px', borderRadius: 8,
            background: 'color-mix(in oklab, var(--keep) 15%, transparent)',
            color: 'var(--keep)', border: '1px solid color-mix(in oklab, var(--keep) 30%, transparent)',
            fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)',
            letterSpacing: 'var(--tracking-meta)', textTransform: 'uppercase',
          }}
        >
          <Icon name="check" size={14} />
          Keep
        </button>
        <button
          onClick={onReject}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '6px 14px', borderRadius: 8,
            background: 'color-mix(in oklab, var(--reject) 12%, transparent)',
            color: 'var(--reject)', border: '1px solid color-mix(in oklab, var(--reject) 25%, transparent)',
            fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)',
            letterSpacing: 'var(--tracking-meta)', textTransform: 'uppercase',
          }}
        >
          <Icon name="x" size={14} />
          Reject
        </button>
      </div>
    </section>
  )
}

function FilmstripThumb({ photo, isInPair, isLeft, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        flexShrink: 0, width: 80, height: 64,
        overflow: 'hidden', cursor: 'pointer',
        position: 'relative', borderRadius: 6,
        border: isInPair
          ? `2px solid ${isLeft ? 'var(--accent)' : 'color-mix(in oklab, var(--accent) 55%, transparent)'}`
          : '1px solid var(--line)',
        opacity: isInPair ? 1 : .45,
        transition: 'all .2s var(--ease-out)',
      }}
    >
      {photo?.url ? (
        <img src={photo.url} alt={photo.filename} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      ) : (
        <div style={{ width: '100%', height: '100%', background: 'var(--bg-3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="image" size={18} style={{ color: 'var(--fg-4)' }} />
        </div>
      )}
      {photo?.decision && (
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0, height: 3,
          background: photo.decision === 'keep' ? 'var(--keep)' : photo.decision === 'reject' ? 'var(--reject)' : 'var(--maybe)',
        }} />
      )}
    </div>
  )
}

export default function CompareView() {
  const photos = useStore(state => state.photos)
  const order = useStore(state => state.order)
  const makeDecision = useStore(state => state.makeDecision)

  const [pairIndex, setPairIndex] = useState(0)
  const pairCount = Math.max(1, Math.floor(order.length / 2))

  const leftId = order[pairIndex * 2]
  const rightId = order[pairIndex * 2 + 1]
  const leftPhoto = photos[leftId]
  const rightPhoto = photos[rightId]

  const isBestMatch = useCallback((side) => {
    if (!leftPhoto?.sharpness || !rightPhoto?.sharpness) return false
    return side === 'left'
      ? leftPhoto.sharpness >= rightPhoto.sharpness
      : rightPhoto.sharpness > leftPhoto.sharpness
  }, [leftPhoto, rightPhoto])

  const goNext = useCallback(() => setPairIndex(i => Math.min(i + 1, pairCount - 1)), [pairCount])
  const goPrev = useCallback(() => setPairIndex(i => Math.max(i - 1, 0)), [])

  const decide = useCallback((id, decision) => {
    if (id) makeDecision(id, decision)
  }, [makeDecision])

  const pickWinner = useCallback((winnerId, loserId) => {
    if (winnerId) makeDecision(winnerId, 'keep')
    if (loserId) makeDecision(loserId, 'reject')
    goNext()
  }, [makeDecision, goNext])

  useEffect(() => {
    const handle = (e) => {
      if (e.target.tagName === 'INPUT') return
      if (e.key === 'ArrowRight') goNext()
      else if (e.key === 'ArrowLeft') goPrev()
      else if (e.key === '1') pickWinner(leftId, rightId)
      else if (e.key === '2') pickWinner(rightId, leftId)
    }
    window.addEventListener('keydown', handle)
    return () => window.removeEventListener('keydown', handle)
  }, [goNext, goPrev, pickWinner, leftId, rightId])

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
            <span className="meta">Sync Pan &amp; Zoom</span>
          </div>
          <span className="meta" style={{ color: 'var(--fg-4)' }}>[1] Pick Left · [2] Pick Right · [←/→] Navigate</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="meta" style={{ padding: '4px 10px', background: 'var(--bg-3)', border: '1px solid var(--line)', borderRadius: 6 }}>
            Pair {pairIndex + 1} / {pairCount}
          </span>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              onClick={goPrev}
              disabled={pairIndex === 0}
              className="iconbtn"
              style={{ color: pairIndex === 0 ? 'var(--fg-4)' : 'var(--fg-2)', cursor: pairIndex === 0 ? 'not-allowed' : 'pointer' }}
            >
              <Icon name="arrowL" size={16} />
            </button>
            <button
              onClick={goNext}
              disabled={pairIndex >= pairCount - 1}
              className="iconbtn"
              style={{ color: pairIndex >= pairCount - 1 ? 'var(--fg-4)' : 'var(--fg-2)', cursor: pairIndex >= pairCount - 1 ? 'not-allowed' : 'pointer' }}
            >
              <Icon name="arrowR" size={16} />
            </button>
          </div>
          <button
            onClick={() => pickWinner(
              isBestMatch('left') ? leftId : rightId,
              isBestMatch('left') ? rightId : leftId,
            )}
            disabled={!leftId || !rightId}
            className="btn btn-primary btn-uppercase"
            style={{ height: 36, padding: '0 14px', fontSize: 'var(--fs-xs)' }}
          >
            <Icon name="sparkle" size={13} />
            Pick Winner
          </button>
        </div>
      </div>

      {/* Side-by-side photos */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, gap: 1, background: 'var(--line)' }}>
        <PhotoPanel
          photo={leftPhoto}
          side="left"
          isBestMatch={isBestMatch('left')}
          onKeep={() => decide(leftId, 'keep')}
          onReject={() => decide(leftId, 'reject')}
        />
        <PhotoPanel
          photo={rightPhoto}
          side="right"
          isBestMatch={isBestMatch('right')}
          onKeep={() => decide(rightId, 'keep')}
          onReject={() => decide(rightId, 'reject')}
        />
      </div>

      {/* Filmstrip */}
      <div style={{
        flexShrink: 0, height: 96,
        borderTop: '1px solid var(--line)',
        background: 'var(--bg-2)',
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '0 var(--pad)', overflowX: 'auto',
      }}>
        {order.map((id, i) => {
          const pairOf = Math.floor(i / 2)
          const isLeft = i % 2 === 0
          return (
            <FilmstripThumb
              key={id}
              photo={photos[id]}
              isInPair={pairOf === pairIndex}
              isLeft={isLeft}
              onClick={() => setPairIndex(pairOf)}
            />
          )
        })}
      </div>
    </div>
  )
}
