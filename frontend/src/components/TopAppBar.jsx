import { useNavigate } from 'react-router-dom'
import { useStore } from '../store'
export default function TopAppBar() {
  const navigate  = useNavigate()
  const photos    = useStore(s => s.photos)
  const isScoring = useStore(s => s.isScoring)
  const photoCount  = Object.keys(photos).length
  const rawCount    = Object.values(photos).filter(p => p.isRaw).length

  const statusText = isScoring
    ? 'ANALYZING…'
    : photoCount > 0
      ? `STABLE // ${photoCount.toLocaleString()} ${rawCount > 0 ? 'RAW' : 'IMG'} ASSETS`
      : 'AWAITING SOURCE FOLDER'

  const handleLogout = async () => {
    try {
      await fetch('/auth/logout', { method: 'POST' })
    } finally {
      if (window.google?.accounts?.id) {
        window.google.accounts.id.disableAutoSelect()
      }
      window.location.reload()
    }
  }

  return (
    <header className="hidden md:flex justify-between items-center w-full px-8 h-16 bg-surface/80 backdrop-blur-xl border-b border-outline-variant/10 sticky top-0 z-40 shrink-0">

      {/* Brand */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <svg width="28" height="28" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg">
          <rect width="28" height="28" rx="6" fill="#1A1A1A"/>
          <g transform="translate(14,14)">
            <polygon points="-1.5,-3 2,-3 5,-11 -4,-11" fill="white" opacity="0.92"/>
            <polygon points="-1.5,-3 2,-3 5,-11 -4,-11" fill="white" opacity="0.92" transform="rotate(60)"/>
            <polygon points="-1.5,-3 2,-3 5,-11 -4,-11" fill="white" opacity="0.92" transform="rotate(120)"/>
            <polygon points="-1.5,-3 2,-3 5,-11 -4,-11" fill="white" opacity="0.92" transform="rotate(180)"/>
            <polygon points="-1.5,-3 2,-3 5,-11 -4,-11" fill="white" opacity="0.92" transform="rotate(240)"/>
            <polygon points="-1.5,-3 2,-3 5,-11 -4,-11" fill="white" opacity="0.92" transform="rotate(300)"/>
            <circle cx="0" cy="0" r="3.5" fill="#1A1A1A"/>
          </g>
        </svg>
        <span style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: 15, letterSpacing: '-0.01em', color: 'var(--fg)' }}>
          BigBadPhotos
        </span>
        <span style={{
          padding: '2px 8px', borderRadius: 999,
          background: 'var(--accent-soft)',
          border: '1px solid color-mix(in oklab, var(--accent) 35%, transparent)',
          fontFamily: 'var(--font-mono)', fontSize: 10,
          letterSpacing: '0.1em', textTransform: 'uppercase',
          color: 'var(--accent)',
        }}>v2</span>
      </div>

      {/* Right: workspace status + actions */}
      <div className="flex items-center gap-6">
        <div className="flex flex-col items-end">
          <span className="text-[10px] font-bold tracking-[0.2em] text-on-surface-variant/60 uppercase">WORKSPACE STATUS</span>
          <span className={`text-xs font-mono ${isScoring ? 'text-tertiary' : photoCount > 0 ? 'text-primary' : 'text-on-surface-variant/40'}`}>
            {statusText}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => navigate('/review')}
            className="p-2 hover:bg-surface-container transition-colors text-on-surface-variant/60 active:scale-95"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>notifications</span>
          </button>
          <button className="p-2 hover:bg-surface-container transition-colors text-on-surface-variant/60 active:scale-95">
            <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>account_circle</span>
          </button>
          <button
            onClick={handleLogout}
            className="p-2 hover:bg-surface-container transition-colors text-on-surface-variant/60 active:scale-95"
            title="Sign out"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>logout</span>
          </button>
        </div>
      </div>
    </header>
  )
}
