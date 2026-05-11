/**
 * FocusView — full-screen view for studio environments.
 * Always shows the most recent burst. Cmd/Ctrl+F navigates here.
 */
import { useStore } from '../store'
import BurstScrubber from '../components/BurstScrubber'
import ConnectionHUD from '../components/ConnectionHUD'

export default function FocusView() {
  const bursts = useStore(s => s.bursts)
  const latest = bursts[0] ?? null

  return (
    <div className="h-full flex flex-col bg-black">
      {/* Status bar */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-white/5">
        <span className="text-[10px] uppercase tracking-widest text-white/30 font-bold">Focus Mode</span>
        <ConnectionHUD />
      </div>

      {/* Hero area */}
      <div className="flex-1 flex items-center justify-center p-8">
        {latest ? (
          <div className="w-full max-w-2xl">
            <BurstScrubber burst={latest} />
          </div>
        ) : (
          <div className="text-white/20 text-sm font-mono animate-pulse">
            Waiting for burst from camera…
          </div>
        )}
      </div>

      {/* Burst count footer */}
      {bursts.length > 1 && (
        <div className="text-center pb-4 text-white/20 text-[10px] tracking-widest uppercase">
          +{bursts.length - 1} more burst{bursts.length > 2 ? 's' : ''} in tray
        </div>
      )}
    </div>
  )
}
