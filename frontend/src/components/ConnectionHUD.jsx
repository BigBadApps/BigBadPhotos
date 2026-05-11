/**
 * ConnectionHUD — Camera Bridge status indicator.
 *
 * Shows three states:
 *   bridge_disabled  — BBP_FTP_PASS not set; grey, "BRIDGE OFF"
 *   waiting          — bridge enabled, no frames yet; amber pulse, "WAITING FOR CAMERA"
 *   live             — frames arriving; cyan pulse, "LIVE"
 *
 * Compact prop: renders as a small chip (for BottomNavBar).
 */
import { useStore } from '../store'

const STATE_STYLES = {
  bridge_disabled: { color: 'text-white/20', dot: 'bg-white/20',       label: 'BRIDGE OFF'         },
  waiting:         { color: 'text-amber-400', dot: 'bg-amber-400 animate-pulse', label: 'WAITING FOR CAMERA' },
  live:            { color: 'text-cyan-400',  dot: 'bg-cyan-400 animate-pulse',  label: 'LIVE'               },
}

export default function ConnectionHUD({ compact = false }) {
  const bridgeEnabled  = useStore(s => s.bridgeEnabled)
  const liveFrameCount = useStore(s => s.liveFrames.length)

  const state = !bridgeEnabled
    ? 'bridge_disabled'
    : liveFrameCount > 0
      ? 'live'
      : 'waiting'

  const { color, dot, label } = STATE_STYLES[state]

  if (compact) {
    return (
      <span className={`inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-widest ${color}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
        {label}
      </span>
    )
  }

  return (
    <div className={`flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest ${color}`}>
      <span className={`w-2 h-2 rounded-full ${dot}`} />
      <span>{label}</span>
    </div>
  )
}
