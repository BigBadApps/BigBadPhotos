import { useState, useEffect, useCallback } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useStore } from './store';
import GoogleGate from './components/GoogleGate';
import AppBar from './components/AppBar';
import HelpOverlay from './components/HelpOverlay';
import LandingView from './views/LandingView';
import CullingView from './views/CullingView';
import CompareView from './views/CompareView';
import ReviewExportView from './views/ReviewExportView';
import { usePhotoLoader } from './hooks/usePhotoLoader';
import { usePhotoRanker } from './hooks/usePhotoRanker';
import { useSessionPersistence } from './hooks/useSessionPersistence';

const HAS_DIR_PICKER = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

function AppContent() {
  const navigate = useNavigate();
  const location = useLocation();
  const [help, setHelp] = useState(false);

  const sourceDir    = useStore(state => state.sourceDir);
  const destDir      = useStore(state => state.destDir);
  const setSourceDir = useStore(state => state.setSourceDir);
  const setDestDir   = useStore(state => state.setDestDir);
  const clearPhotos  = useStore(state => state.clearPhotos);
  const photos       = useStore(state => state.photos);
  const order        = useStore(state => state.order);

  const { loading: photoLoading, loadingComplete, loadedCount, totalCount, loadError } = usePhotoLoader();
  const { scoring, scoredCount, scoreError, backendAvailable, scoreableCount } = usePhotoRanker(loadingComplete);
  useSessionPersistence(loadingComplete);

  const currentView = location.pathname === '/'        ? 'landing'
    : location.pathname === '/cull'    ? 'culling'
    : location.pathname === '/compare' ? 'compare'
    : 'export';

  const stepMap = { landing: 2, culling: 3, compare: 4, export: 5 };

  useEffect(() => {
    function onKey(e) {
      if (e.key === '?' || (e.shiftKey && e.key === '/')) { e.preventDefault(); setHelp(h => !h); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pickSource = useCallback(async () => {
    if (!HAS_DIR_PICKER) return;
    try {
      const dir = await window.showDirectoryPicker({ mode: 'read' });
      clearPhotos();
      setSourceDir(dir);
    } catch (err) {
      if (err.name !== 'AbortError') console.error('Source picker:', err);
    }
  }, [setSourceDir, clearPhotos]);

  const pickExport = useCallback(async () => {
    if (!HAS_DIR_PICKER) return;
    try {
      const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
      setDestDir(dir);
    } catch (err) {
      if (err.name !== 'AbortError') console.error('Export picker:', err);
    }
  }, [setDestDir]);

  // Derive file type label from loaded photos
  const rawCount = Object.values(photos).filter(p => p.isRaw).length;
  const webCount = Object.values(photos).filter(p => !p.isRaw).length;
  const fileType = rawCount > 0 && webCount > 0 ? 'RAW + JPG'
    : rawCount > 0 ? 'RAW'
    : webCount > 0 ? 'JPG / PNG'
    : '—';

  const landingState = {
    source:          sourceDir?.name || '',
    exportTarget:    destDir?.name   || '',
    total:           totalCount || order.length,
    fileType,
    scored:          scoredCount,
    scoreableCount,
    isLoading:       photoLoading,
    loadingComplete,
    loadedCount,
    loadError,
    scoring,
    scoreError,
    backendAvailable,
    hasPhotos:       order.length > 0,
  };

  const hasPhotos = order.length > 0;

  return (
    <div className="app-root">
      <AppBar
        view={currentView}
        step={stepMap[currentView]}
        totalSteps={5}
        onHelp={() => setHelp(true)}
        projectName={sourceDir?.name || null}
      />
      <div style={{ flex: 1, position: 'relative', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <Routes>
          <Route path="/" element={
            <LandingView
              state={landingState}
              onSelectSource={pickSource}
              onSelectExport={pickExport}
              onBegin={() => navigate('/cull')}
            />
          } />
          <Route path="/cull"    element={hasPhotos ? <CullingView feedbackIntensity="pronounced" showInlineKbd onComplete={() => navigate('/review')} /> : <Navigate to="/" />} />
          <Route path="/compare" element={hasPhotos ? <CompareView /> : <Navigate to="/" />} />
          <Route path="/review"  element={hasPhotos ? <ReviewExportView /> : <Navigate to="/" />} />
        </Routes>
        <HelpOverlay open={help} onClose={() => setHelp(false)} />
      </div>

      <nav style={{
        position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)',
        display: 'flex', gap: 4, padding: 4,
        background: 'color-mix(in oklab, var(--bg-2) 85%, transparent)',
        backdropFilter: 'blur(12px)', border: '1px solid var(--line)',
        borderRadius: 999, zIndex: 40, boxShadow: 'var(--shadow-2)',
      }}>
        {[
          ['/', 'Landing'],
          ['/cull', 'Culling'],
          ['/compare', 'Compare'],
          ['/review', 'Export'],
        ].map(([path, label]) => (
          <button
            key={path}
            onClick={() => navigate(path)}
            className="mono fs-xxs upper"
            style={{
              padding: '8px 14px', borderRadius: 999,
              background: location.pathname === path ? 'var(--accent-soft)' : 'transparent',
              color: location.pathname === path ? 'var(--accent)' : 'var(--fg-3)',
              transition: 'all .15s',
            }}
          >{label}</button>
        ))}
      </nav>
    </div>
  );
}

export default function App() {
  useEffect(() => {
    const r = document.documentElement;
    r.setAttribute('data-theme', 'surgical');
    r.setAttribute('data-mode', 'auto');
    r.setAttribute('data-density', 'comfortable');
  }, []);

  return (
    <GoogleGate>
      <Router>
        <AppContent />
      </Router>
    </GoogleGate>
  );
}
