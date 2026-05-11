import { useEffect } from 'react'
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import { useStore } from './store'
import LandingView from './views/LandingView'
import CullingView from './views/CullingView'
import CompareView from './views/CompareView'
import ReviewExportView from './views/ReviewExportView'
import Sidebar from './components/Sidebar'
import TopAppBar from './components/TopAppBar'
import BottomNavBar from './components/BottomNavBar'
import GoogleGate from './components/GoogleGate'

function AppContent() {
  const sourceDir = useStore(state => state.sourceDir)
  const setCurrentRoute = useStore(state => state.setCurrentRoute)
  const authSessionExpired = useStore(state => state.authSessionExpired)

  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        setCurrentRoute('/review')
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [setCurrentRoute])

  return (
    <div className="flex h-screen overflow-hidden bg-surface text-on-surface">
      <Sidebar />
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {authSessionExpired && (
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="shrink-0 w-full bg-error/90 text-on-error text-center py-2 px-4 text-[10px] font-bold tracking-widest uppercase hover:bg-error transition-colors"
          >
            Session expired · reload to sign in
          </button>
        )}
        <TopAppBar />
        <main className="flex-1 overflow-hidden">
          <Routes>
            <Route path="/" element={<LandingView />} />
            <Route path="/cull" element={sourceDir ? <CullingView /> : <Navigate to="/" />} />
            <Route path="/compare" element={sourceDir ? <CompareView /> : <Navigate to="/" />} />
            <Route path="/review" element={sourceDir ? <ReviewExportView /> : <Navigate to="/" />} />
          </Routes>
        </main>
        <BottomNavBar />
      </div>
    </div>
  )
}

export default function App() {
  return (
    <GoogleGate>
      <Router>
        <AppContent />
      </Router>
    </GoogleGate>
  )
}
