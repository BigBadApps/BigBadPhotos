import { useState, useEffect, useCallback, useRef } from 'react';
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
  const addPhotos    = useStore(state => state.addPhotos);
  const setCurrentId = useStore(state => state.setCurrentId);
  const fileInputRef = useRef(null);
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

  const WEB_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);
  const IMG_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'raw', 'arw', 'cr2', 'cr3', 'nef', 'dng', 'orf', 'rw2', 'raf', 'tif', 'tiff']);

  const handleFileInput = useCallback((e) => {
    const files = Array.from(e.target.files)
      .filter(f => IMG_EXTS.has(f.name.split('.').pop().toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name));
    e.target.value = '';
    if (!files.length) return;
    clearPhotos();
    const photos = files.map(f => {
      const ext = f.name.split('.').pop().toLowerCase();
      const isWeb = WEB_EXTS.has(ext);
      return {
        id: f.name, filename: f.name,
        url: isWeb ? URL.createObjectURL(f) : null,
        file: f, fileHandle: null,
        isRaw: !isWeb, decision: null, rank: null, sharpness: null,
      };
    });
    addPhotos(photos);
    if (photos[0]) setCurrentId(photos[0].id);
    const folder = files[0].webkitRelativePath?.split('/')[0] || `${files.length} photos`;
    setSourceDir({ name: folder, _ios: true });
  }, [clearPhotos, addPhotos, setCurrentId, setSourceDir]);

  // On iOS, auto-set a pseudo destDir so "Begin Review" can be unlocked.
  // Export uses Web Share / sequential downloads instead of a real folder.
  useEffect(() => {
    if (!HAS_DIR_PICKER && !destDir) {
      setDestDir({ name: 'Download to device', _ios: true });
    }
  }, []);

  const pickSource = useCallback(async () => {
    if (!HAS_DIR_PICKER) {
      fileInputRef.current?.click();
      return;
    }
    try {
      const dir = await window.showDirectoryPicker({ mode: 'read' });
      clearPhotos();
      setSourceDir(dir);
    } catch (err) {
      if (err.name !== 'AbortError') console.error('Source picker:', err);
    }
  }, [setSourceDir, clearPhotos]);

  const pickExport = useCallback(async () => {
    if (!HAS_DIR_PICKER) return; // iOS exports via download/share — no folder needed
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
      <input
        ref={fileInputRef}
        type="file"
        webkitdirectory=""
        multiple
        style={{ display: 'none' }}
        onChange={handleFileInput}
      />
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
