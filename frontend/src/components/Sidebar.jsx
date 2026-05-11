import { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'

const navItems = [
  { label: 'Library',    route: '/',        icon: 'grid_view' },
  { label: 'Cull',       route: '/cull',     icon: 'collections' },
  { label: 'Compare',    route: '/compare',  icon: 'compare' },
  { label: 'Export',     route: '/review',   icon: 'ios_share' },
  { label: 'Preferences',route: null,        icon: 'tune' },
]

export default function Sidebar() {
  const navigate  = useNavigate()
  const location  = useLocation()
  const [health, setHealth] = useState(null) // null=loading, true=ok, false=error

  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch('/health', { signal: AbortSignal.timeout(4000) })
        setHealth(res.ok)
      } catch {
        setHealth(false)
      }
    }
    check()
    const id = setInterval(check, 30000)
    return () => clearInterval(id)
  }, [])

  return (
    <aside className="hidden md:flex flex-col shrink-0 bg-surface-container-lowest border-r border-white/5 z-50 w-24 lg:w-64">

      {/* Logo */}
      <div className="px-4 lg:px-6 py-8 flex items-center justify-center lg:justify-start gap-3">
        <span className="material-symbols-outlined text-primary-container" style={{ fontSize: '22px' }}>lens_blur</span>
        <h1 className="hidden lg:block text-base font-black text-primary-container tracking-tighter">BIGBADPHOTOS</h1>
      </div>

      {/* Nav */}
      <nav className="flex flex-col flex-1 mt-2">
        {navItems.map(item => {
          const active = item.route && location.pathname === item.route
          return (
            <button
              key={item.label}
              onClick={() => item.route && navigate(item.route)}
              className={`flex flex-col lg:flex-row items-center gap-1 lg:gap-4 py-4 px-4 lg:px-6 min-h-[56px] transition-all text-[11px] font-bold uppercase tracking-widest ${
                active
                  ? 'bg-surface-container text-primary-container border-l-2 border-primary-container'
                  : 'text-secondary/50 hover:text-on-surface hover:bg-surface-container border-l-2 border-transparent'
              } ${!item.route ? 'cursor-default' : 'cursor-pointer'}`}
            >
              <span
                className="material-symbols-outlined"
                style={{
                  fontSize: '22px',
                  fontVariationSettings: active ? "'FILL' 1, 'wght' 300" : "'FILL' 0, 'wght' 300",
                }}
              >
                {item.icon}
              </span>
              <span className="hidden lg:block">{item.label}</span>
            </button>
          )
        })}
      </nav>

      {/* NEW IMPORT button */}
      <div className="px-4 lg:px-6 mb-6">
        <button
          onClick={() => navigate('/')}
          className="w-full bg-primary-container text-on-primary py-3 font-bold text-[11px] tracking-widest uppercase hover:brightness-110 transition-all active:scale-[0.98] hidden lg:flex items-center justify-center"
        >
          NEW IMPORT
        </button>
        <button
          onClick={() => navigate('/')}
          className="lg:hidden w-full flex items-center justify-center py-3 bg-primary-container text-on-primary hover:brightness-110 transition-all active:scale-[0.98]"
        >
          <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>add</span>
        </button>
      </div>

      {/* Footer */}
      <div className="border-t border-white/5 pb-4">
        <div className="w-full flex flex-col lg:flex-row items-center gap-1 lg:gap-3 py-3 px-4 lg:px-6 text-[10px] tracking-widest uppercase">
          <span
            className="material-symbols-outlined"
            style={{
              fontSize: '18px',
              color: health === null ? '#9ccee2' : health ? '#00d1ff' : '#ffb4ab',
            }}
          >
            sensors
          </span>
          <span className="hidden lg:flex items-center gap-2">
            <span
              className="inline-block w-1.5 h-1.5 rounded-full"
              style={{ background: health === null ? '#9ccee2' : health ? '#00d1ff' : '#ffb4ab' }}
            />
            <span style={{ color: health === null ? '#9ccee2' : health ? '#00d1ff' : '#ffb4ab' }}>
              {health === null ? 'CHECKING…' : health ? 'ONLINE' : 'OFFLINE'}
            </span>
          </span>
        </div>
      </div>
    </aside>
  )
}
