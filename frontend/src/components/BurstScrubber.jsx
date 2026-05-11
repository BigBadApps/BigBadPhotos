/**
 * BurstScrubber — single burst card with hover/touch scrub and Hero selection.
 *
 * Desktop: mousemove seeks <video> currentTime.
 * Mobile:  touchmove seeks (preventDefault stops scroll).
 * "Select Hero" → POST /burst/select → stores heroUrl in Zustand.
 */
import { useRef, useState, useCallback } from 'react'
import { useStore } from '../store'

export default function BurstScrubber({ burst }) {
  const { burstId, previewUrl, frameCount, fps } = burst
  const videoRef = useRef(null)
  const [frame,  setFrame]  = useState(0)
  const [status, setStatus] = useState('idle') // idle | loading | done | error
  const setBurstHero = useStore(s => s.setBurstHero)
  const duration     = frameCount / fps

  const seek = useCallback((clientX, rect) => {
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    setFrame(Math.floor(pct * (frameCount - 1)))
    if (videoRef.current) videoRef.current.currentTime = pct * duration
  }, [frameCount, duration])

  const handleSelect = async () => {
    if (status === 'loading' || status === 'done') return
    setStatus('loading')
    try {
      const res  = await fetch('/burst/select', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ burstId, frameIndex: frame }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setBurstHero({ burstId, frameIndex: frame, heroUrl: data.heroUrl })
      setStatus('done')
    } catch (err) {
      console.error('Hero select failed:', err)
      setStatus('error')
    }
  }

  return (
    <div
      className="relative rounded-lg overflow-hidden border border-white/10 bg-surface-alt group cursor-crosshair select-none"
      onMouseMove={e => seek(e.clientX, e.currentTarget.getBoundingClientRect())}
      onTouchMove={e => { e.preventDefault(); seek(e.touches[0].clientX, e.currentTarget.getBoundingClientRect()) }}
      onTouchStart={e => seek(e.touches[0].clientX, e.currentTarget.getBoundingClientRect())}
    >
      {/* Burst badge */}
      <div className="absolute top-2 left-2 z-10 bg-cyan-500/90 text-black text-[9px] font-bold px-1.5 py-0.5 rounded tracking-widest uppercase pointer-events-none">
        {fps}fps · {frameCount}f
      </div>

      {/* Frame counter */}
      <div className="absolute top-2 right-2 z-10 bg-black/60 text-white/70 text-[9px] font-mono px-1.5 py-0.5 rounded pointer-events-none">
        {String(frame + 1).padStart(3, '0')}/{frameCount}
      </div>

      {/* "Curtain View" — processing overlay per spec §4 */}
      {status === 'loading' && (
        <div className="absolute inset-0 z-20 bg-black/70 flex flex-col items-center justify-center gap-2 pointer-events-none">
          <div className="w-32 h-[2px] bg-white/10 rounded overflow-hidden">
            <div className="h-full bg-cyan-500 animate-[curtain_1s_ease-in-out_infinite]" style={{ width: '60%' }} />
          </div>
          <span className="text-cyan-400 text-[10px] uppercase tracking-widest">Linking hero…</span>
        </div>
      )}

      <video
        ref={videoRef}
        src={previewUrl}
        muted playsInline preload="auto"
        className="w-full aspect-[3/2] object-cover pointer-events-none"
      />

      {/* Scrub progress bar */}
      <div className="absolute bottom-8 left-0 right-0 h-[2px] bg-white/10 pointer-events-none">
        <div
          className="h-full bg-cyan-500"
          style={{ width: `${(frame / Math.max(frameCount - 1, 1)) * 100}%`, transition: 'none' }}
        />
      </div>

      {/* Select hero button */}
      <div className="absolute bottom-2 left-0 right-0 flex justify-center opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={handleSelect}
          disabled={status === 'loading' || status === 'done'}
          className="bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 text-black text-[10px] font-bold px-3 py-1 rounded uppercase tracking-widest"
        >
          {status === 'done' ? '✓ Hero Selected' : status === 'error' ? 'Retry' : 'Select Hero'}
        </button>
      </div>

      {/* Send to Refine stub — Phase 2 */}
      {status === 'done' && (
        <button disabled title="Project Refine — Phase 2"
          className="absolute bottom-2 right-2 bg-white/5 text-white/20 text-[9px] font-bold px-1.5 py-0.5 rounded tracking-widest uppercase cursor-not-allowed">
          → Refine
        </button>
      )}
    </div>
  )
}
