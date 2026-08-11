import { useNavigate, useLocation } from 'react-router-dom'

const navItems = [
  { label: 'LIBRARY', route: '/',        icon: 'grid_view' },
  { label: 'DEVELOP', route: '/cull',     icon: 'tune' },
  { label: 'REVIEW',  route: '/compare',  icon: 'visibility' },
  { label: 'EXPORT',  route: '/review',   icon: 'ios_share' },
  { label: 'SESSIONS', route: '/sessions', icon: 'photo_camera' },
]

export default function BottomNavBar() {
  const navigate  = useNavigate()
  const location  = useLocation()

  return (
    <nav className="md:hidden h-20 shrink-0 bg-surface border-t border-surface-container-highest/20 flex justify-around items-center px-2">
      {navItems.map(item => {
        const active = location.pathname === item.route
        return (
          <button
            key={item.label}
            onClick={() => navigate(item.route)}
            className={`flex flex-col items-center justify-center gap-1 transition-all active:brightness-125 ${
              active ? 'text-primary-container font-black' : 'text-secondary/50 hover:text-primary'
            }`}
          >
            <span
              className="material-symbols-outlined mb-0.5"
              style={{
                fontSize: '22px',
                fontVariationSettings: active ? "'FILL' 1, 'wght' 400" : "'FILL' 0, 'wght' 300",
              }}
            >
              {item.icon}
            </span>
            <span className="text-[10px] font-bold uppercase tracking-widest">{item.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
