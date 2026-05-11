import { useStore } from '../store'
import BurstScrubber from './BurstScrubber'

export default function BurstTray() {
  const bursts = useStore(s => s.bursts)
  if (!bursts.length) return null

  return (
    <div className="flex flex-col gap-3 p-3 border-b border-white/5">
      <div className="text-[10px] uppercase tracking-widest text-white/40 font-bold flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-cyan-500 animate-pulse" />
        Live Bursts
      </div>
      {bursts.map(b => <BurstScrubber key={b.burstId} burst={b} />)}
    </div>
  )
}
