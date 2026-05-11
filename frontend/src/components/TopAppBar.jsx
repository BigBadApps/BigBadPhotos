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

      <div />

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
