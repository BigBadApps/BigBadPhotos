import { useRef, useState, useCallback } from 'react'

/**
 * Before/after image comparison with wipe, zoom, and pan.
 *
 * - Wipe: drag the handle (or use the Wipe slider) to reveal left vs right.
 * - Zoom: 1× shows the whole frame (object-fit: contain); drag up to 8× to pixel-peep.
 * - Pan: once zoomed, drag anywhere on the image to move around (clamped to edges).
 *
 * Both images share one transform so the two sides stay pixel-aligned.
 *
 * @param {string} originalUrl   left image (e.g. /edit/file?...variant=original)
 * @param {string} editedUrl     right image (...variant=edited)
 * @param {string} [leftLabel]   default "Original"
 * @param {string} [rightLabel]  default "Edited"
 * @param {string} [aspectRatio] CSS aspect-ratio for the frame, default "3 / 2"
 */
export default function BeforeAfterViewer({
  originalUrl,
  editedUrl,
  leftLabel = 'Original',
  rightLabel = 'Edited',
  aspectRatio = '3 / 2',
}) {
  const frameRef = useRef(null)
  const drag = useRef({ mode: null, startX: 0, startY: 0, panX: 0, panY: 0 })

  const [wipe, setWipe] = useState(50)   // 0..100
  const [zoom, setZoom] = useState(100)  // 100..800 (percent)
  const [pan, setPan] = useState({ x: 0, y: 0 })

  const scale = zoom / 100

  const clamp = useCallback((x, y, s) => {
    const r = frameRef.current?.getBoundingClientRect()
    if (!r) return { x, y }
    const mx = Math.max(0, (r.width * (s - 1)) / 2)
    const my = Math.max(0, (r.height * (s - 1)) / 2)
    return {
      x: Math.max(-mx, Math.min(mx, x)),
      y: Math.max(-my, Math.min(my, y)),
    }
  }, [])

  const wipeFromClientX = useCallback((clientX) => {
    const r = frameRef.current?.getBoundingClientRect()
    if (!r) return
    setWipe(Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)))
  }, [])

  const onPointerDown = useCallback((e) => {
    const frame = frameRef.current
    if (frame?.setPointerCapture) {
      try { frame.setPointerCapture(e.pointerId) } catch { /* ignore */ }
    }
    if (e.target.dataset?.role === 'handle') {
      drag.current.mode = 'wipe'
      wipeFromClientX(e.clientX)
    } else {
      drag.current = { mode: 'pan', startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y }
    }
    e.preventDefault()
  }, [pan, wipeFromClientX])

  const onPointerMove = useCallback((e) => {
    const d = drag.current
    if (d.mode === 'wipe') {
      wipeFromClientX(e.clientX)
      e.preventDefault()
    } else if (d.mode === 'pan') {
      setPan(clamp(d.panX + (e.clientX - d.startX), d.panY + (e.clientY - d.startY), scale))
      e.preventDefault()
    }
  }, [clamp, scale, wipeFromClientX])

  const endDrag = useCallback(() => { drag.current.mode = null }, [])

  const onZoomChange = useCallback((e) => {
    const z = parseFloat(e.target.value)
    setZoom(z)
    setPan((p) => clamp(p.x, p.y, z / 100))
  }, [clamp])

  const fit = useCallback(() => { setZoom(100); setPan({ x: 0, y: 0 }) }, [])

  const transform = `translate(${pan.x}px, ${pan.y}px) scale(${scale})`
  const imgStyle = {
    position: 'absolute', inset: 0, width: '100%', height: '100%',
    objectFit: 'contain', transformOrigin: 'center center', transform,
    pointerEvents: 'none', willChange: 'transform',
  }
  const tagStyle = {
    position: 'absolute', top: 8, padding: '3px 9px', borderRadius: 'var(--r-1)',
    fontSize: 'var(--fs-xxs)', letterSpacing: 'var(--tracking-meta)', textTransform: 'uppercase',
    background: 'rgba(0,0,0,.6)', color: '#fff', zIndex: 3, pointerEvents: 'none',
  }
  const ctlRow = { display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', flex: 1, minWidth: 220 }
  const ctlLabel = { fontSize: 'var(--fs-xs)', color: 'var(--fg-2)', whiteSpace: 'nowrap' }
  const ctlVal = { fontSize: 'var(--fs-xs)', color: 'var(--fg)', minWidth: 44, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }

  return (
    <div className="ba-viewer">
      <div style={{
        display: 'flex', gap: 'var(--sp-6)', flexWrap: 'wrap', alignItems: 'center',
        marginBottom: 'var(--sp-3)', padding: 'var(--sp-3) var(--sp-4)',
        background: 'var(--bg-3)', border: '1px solid var(--line)', borderRadius: 'var(--r-2)',
      }}>
        <div style={ctlRow}>
          <span style={ctlLabel}>Wipe</span>
          <input type="range" min="0" max="100" step="1" value={wipe}
                 onChange={(e) => setWipe(parseFloat(e.target.value))}
                 style={{ flex: 1, accentColor: 'var(--accent)' }} />
          <span style={ctlVal}>{Math.round(wipe)}%</span>
        </div>
        <div style={ctlRow}>
          <span style={ctlLabel}>Zoom</span>
          <input type="range" min="100" max="800" step="5" value={zoom}
                 onChange={onZoomChange}
                 style={{ flex: 1, accentColor: 'var(--accent)' }} />
          <span style={ctlVal}>{scale.toFixed(1)}×</span>
          <button type="button" onClick={fit}
                  style={{ background: 'var(--bg-4)', color: 'var(--fg)', border: '1px solid var(--line-2)',
                           borderRadius: 'var(--r-1)', padding: '5px 10px', cursor: 'pointer', fontSize: 'var(--fs-xs)' }}>
            Fit
          </button>
        </div>
      </div>

      <div
        ref={frameRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{
          position: 'relative', width: '100%', aspectRatio, margin: '0 auto', overflow: 'hidden',
          borderRadius: 'var(--r-2)', background: '#000', userSelect: 'none', touchAction: 'none',
          cursor: scale > 1 ? 'grab' : 'default',
        }}
      >
        <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
          <img src={editedUrl} alt={rightLabel} style={imgStyle} />
        </div>
        <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', clipPath: `inset(0 ${100 - wipe}% 0 0)` }}>
          <img src={originalUrl} alt={leftLabel} style={imgStyle} />
        </div>

        <span style={{ ...tagStyle, left: 8 }}>{leftLabel}</span>
        <span style={{ ...tagStyle, right: 8 }}>{rightLabel}</span>

        <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${wipe}%`, width: 2, background: '#fff', transform: 'translateX(-1px)', zIndex: 2, pointerEvents: 'none' }} />
        <div
          data-role="handle"
          style={{
            position: 'absolute', top: '50%', left: `${wipe}%`, width: 38, height: 38,
            margin: '-19px 0 0 -19px', borderRadius: '50%', background: '#fff', color: '#111',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
            cursor: 'ew-resize', boxShadow: '0 1px 6px rgba(0,0,0,.5)', zIndex: 3,
          }}
        >⇆</div>
      </div>
    </div>
  )
}
