/**
 * LiveFeedGrid — real-time frame grid for Camera Bridge sessions.
 *
 * Frames arrive via WS frame_arrived events → addLiveFrame → liveFrames array.
 * Newest frame always appears top-left (array prepended).
 * Burst frames show "BURST" badge and collapse into BurstScrubber on click.
 * Max 200 frames kept in memory (configurable via LIVE_GRID_MAX).
 */
import { useState } from 'react'
import { useStore } from '../store'

const LIVE_GRID_MAX = 200

export default function LiveFeedGrid() {
  const liveFrames = useStore(s => s.liveFrames.slice(0, LIVE_GRID_MAX))
  const bursts     = useStore(s => s.bursts)
  const [expanded, setExpanded] = useState(null)

  if (!liveFrames.length) {
    return (
      <div className="flex-1 flex items-center justify-center text-white/20 text-sm font-mono animate-pulse">
        Waiting for camera frames…
      </div>
    )
  }

  return (
    <div
      className="p-3 overflow-y-auto"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
        gap: 8,
        alignContent: 'start',
      }}
    >
      {liveFrames.map(f => {
        // Check if this frame belongs to a received burst
        const burst = bursts.find(b =>
          b.frameCount && f.frameId && b.burstId === f.burstId
        )
        return (
          <div
            key={f.frameId}
            className="relative rounded overflow-hidden border border-white/10 cursor-pointer hover:border-cyan-500/50 transition-colors"
            style={{ aspectRatio: '3/2' }}
            onClick={() => burst && setExpanded(expanded === burst.burstId ? null : burst.burstId)}
          >
            <img
              src={f.url}
              alt=""
              loading="lazy"
              decoding="async"
              className="w-full h-full object-cover"
            />
            {/* Burst badge — spec §3 Module C */}
            {f.isBurst && (
              <div className="absolute top-1 left-1 bg-cyan-500/90 text-black text-[8px] font-bold px-1 py-0.5 rounded tracking-widest uppercase">
                BURST
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
