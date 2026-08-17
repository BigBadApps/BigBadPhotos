import { useState, useEffect, useCallback, useRef } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useStore } from './store';
import GoogleGate from './components/GoogleGate';
import AppBar from './components/AppBar';
import HelpOverlay from './components/HelpOverlay';
import SessionHubView from './views/SessionHubView';
import SessionAreaView from './views/SessionAreaView';
import LandingView from './views/LandingView';
import CullingView from './views/CullingView';
import CompareView from './views/CompareView';
import EditView from './views/EditView';
import ReviewExportView from './views/ReviewExportView';
import RunView from './views/RunView';
import ReviewQueueView from './views/ReviewQueueView';
import FavoritesReviewView from './views/FavoritesReviewView';
import GalleryShell from './views/Gallery/GalleryShell';
import GalleryGrid from './views/Gallery/GalleryGrid';
import GalleryFavorites from './views/Gallery/GalleryFavorites';
import { usePhotoLoader } from './hooks/usePhotoLoader';
import { usePhotoRanker } from './hooks/usePhotoRanker';
import { useSessionPersistence } from './hooks/useSessionPersistence';
import GoogleDriveFolderPicker from './components/GoogleDriveFolderPicker';
import {
  DRIVE_SCOPES,
  authorizeDriveToken,
  hasValidDriveSession,
  prepareDriveAuth,
  requestDriveAccessFromGesture,
  resumeDriveRedirectIfNeeded,
} from './utils/googleDrive';
import { useAutonomousMode } from './hooks/useAutonomousMode';

const HAS_DIR_PICKER = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

function AppContent() {
  const navigate = useNavigate();
  const location = useLocation();
  const [help, setHelp] = useState(false);
  const handleCloseHelp = useCallback(() => setHelp(false), []);
  const [toast, setToast] = useState(null);
  const [drivePicker, setDrivePicker] = useState(null);
  const [driveError, setDriveError] = useState(null);
  const [driveConnecting, setDriveConnecting] = useState(false);
  const [driveConnectLabel, setDriveConnectLabel] = useState('');
  const [driveAvailable, setDriveAvailable] = useState(false);
  const [driveAuthReady, setDriveAuthReady] = useState(false);
  const [authDev, setAuthDev] = useState(false);
  const driveSessionReady = useRef(false);
  const driveConfigRef = useRef(null);

  const sourceDir    = useStore(state => state.sourceDir);
  const destDir      = useStore(state => state.destDir);
  const setSourceDir = useStore(state => state.setSourceDir);
  const setDestDir   = useStore(state => state.setDestDir);
  const clearPhotos  = useStore(state => state.clearPhotos);
  const addPhotos    = useStore(state => state.addPhotos);
  const setCurrentId = useStore(state => state.setCurrentId);
  const fileInputRef   = useRef(null);
  const exportInputRef = useRef(null);
  const photos       = useStore(state => state.photos);
  const order        = useStore(state => state.order);
  const hasPhotos    = order.length > 0;
  const { loading: photoLoading, loadingComplete, loadedCount, totalCount, loadError } = usePhotoLoader();
  const {
    scoring,
    scoredCount,
    scoreError,
    backendAvailable,
    scoreableCount,
    authExpired,
    beginScoring,
    etaSeconds,
    scoringStarted,
  } = usePhotoRanker(loadingComplete);
  useSessionPersistence(loadingComplete);

  const [autoThreshold, setAutoThreshold] = useState(() => {
    try {
      const v = parseFloat(localStorage.getItem('bbp_auto_threshold'))
      if (!Number.isFinite(v)) return 0.65
      return Math.min(0.95, Math.max(0, v))
    } catch { return 0.65 }
  })

  const handleThresholdChange = useCallback((val) => {
    const clamped = Math.min(0.95, Math.max(0, val))
    setAutoThreshold(clamped)
    try { localStorage.setItem('bbp_auto_threshold', String(clamped)) } catch {}
  }, [])

  const autonomousMode = useAutonomousMode({
    sourceDir,
    destDir,
    threshold: autoThreshold,
  })

  const currentView = location.pathname === '/' || location.pathname.startsWith('/sessions') ? 'sessions'
    : location.pathname === '/one-off' ? 'landing'
    : location.pathname === '/cull'    ? 'culling'
    : location.pathname === '/compare' ? 'compare'
    : location.pathname === '/edit'    ? 'edit'
    : location.pathname === '/review-queue' ? 'review-queue'
    : 'export';

  const stepMap = { landing: 2, culling: 3, compare: 4, edit: 5, export: 6 };

  useEffect(() => {
    let toastTimer;
    if (toast) {
      toastTimer = setTimeout(() => setToast(null), 2500);
    }
    return () => clearTimeout(toastTimer);
  }, [toast]);

  useEffect(() => {
    function onKey(e) {
      if (e.repeat) return;
      if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return;
      const k = e.key;
      if ((k === '?' || (e.shiftKey && k === '/')) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setHelp(h => !h);
        return;
      }
      if (k === 'Escape' && help && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setHelp(false);
        return;
      }
      if (k === '1' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); navigate('/'); return; }
      if (k === '2' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (!hasPhotos) { setToast({ message: 'Select a source folder first', at: Date.now() }); return; }
        navigate('/cull');
        return;
      }
      if (k === '3' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (!hasPhotos) { setToast({ message: 'Select a source folder first', at: Date.now() }); return; }
        navigate('/compare');
        return;
      }
      if (k === '4' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (!hasPhotos) { setToast({ message: 'Select a source folder first', at: Date.now() }); return; }
        navigate('/review');
        return;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, hasPhotos, help]);

  useEffect(() => {
    let cancelled = false;
    fetch('/auth/config', { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .then((config) => {
        if (cancelled || !config) return;
        setDriveAvailable(Boolean(config.drive && config.googleClientId));
        setAuthDev(Boolean(config.dev));
      })
      .catch(() => {
        if (!cancelled) setDriveAvailable(false);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!driveAvailable) {
      setDriveAuthReady(false);
      driveSessionReady.current = false;
      driveConfigRef.current = null;
      return undefined;
    }

    let cancelled = false;
    prepareDriveAuth()
      .then(async (config) => {
        if (cancelled) return;
        driveConfigRef.current = config;
        driveSessionReady.current = await hasValidDriveSession();
        setDriveAuthReady(true);
      })
      .catch(() => {
        if (!cancelled) {
          driveSessionReady.current = false;
          setDriveAuthReady(false);
        }
      });

    return () => { cancelled = true; };
  }, [driveAvailable]);

  useEffect(() => {
    if (!driveAvailable) return undefined;

    let cancelled = false;
    resumeDriveRedirectIfNeeded()
      .then((pending) => {
        if (cancelled || (pending !== 'source' && pending !== 'export')) return;
        driveSessionReady.current = true;
        setDrivePicker(pending);
      })
      .catch((err) => {
        if (!cancelled) {
          setDriveError(err?.message || 'Google Drive authorization failed');
        }
      });

    return () => { cancelled = true; };
  }, [driveAvailable]);

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

  const handleExportInput = useCallback((e) => {
    const files = Array.from(e.target.files);
    e.target.value = '';
    const folder = files[0]?.webkitRelativePath?.split('/')[0] || 'Export folder';
    setDestDir({ name: folder, _ios: true });
  }, [setDestDir]);

  const pickSource = useCallback(async () => {
    if (HAS_DIR_PICKER) {
      try {
        const dir = await window.showDirectoryPicker({ mode: 'read' });
        clearPhotos();
        setSourceDir(dir);
        return;
      } catch (err) {
        if (err.name === 'AbortError') return; // user cancelled — no fallback
        // Native picker present but blocked (e.g. Brave Shields) — fall back below.
        console.warn('Source directory picker unavailable, using file input:', err);
      }
    }
    fileInputRef.current?.click();
  }, [setSourceDir, clearPhotos]);

  const pickExport = useCallback(async () => {
    if (HAS_DIR_PICKER) {
      try {
        const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
        setDestDir(dir);
        return;
      } catch (err) {
        if (err.name === 'AbortError') return; // user cancelled — no fallback
        // Native picker present but blocked (e.g. Brave Shields) — fall back below.
        console.warn('Export directory picker unavailable, using file input:', err);
      }
    }
    exportInputRef.current?.click();
  }, [setDestDir]);

  // Derive file type label from loaded photos
  const rawCount = Object.values(photos).filter(p => p.isRaw).length;
  const webCount = Object.values(photos).filter(p => !p.isRaw).length;
  const fileType = rawCount > 0 && webCount > 0 ? 'RAW + JPG'
    : rawCount > 0 ? 'RAW'
    : webCount > 0 ? 'JPG / PNG'
    : '—';

  const scoringPct =
    scoreableCount > 0 ? Math.round((scoredCount / scoreableCount) * 100) : 0;
  const scoringComplete =
    scoreableCount === 0 || (scoringPct === 100 && !scoring);

  const formatFolderLabel = (dir, fallback) => {
    if (!dir) return ''
    if (dir._drive) return `Drive · ${dir.name}`
    return dir.name || fallback
  }

  const landingState = {
    source:          formatFolderLabel(sourceDir, ''),
    exportTarget:    formatFolderLabel(destDir, HAS_DIR_PICKER ? '' : 'Downloads'),
    driveAvailable,
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
    authExpired,
    hasPhotos:       order.length > 0,
    etaSeconds,
    scoringStarted,
    scoringComplete,
    driveError,
    driveConnecting,
    driveAuthReady,
    dev: authDev,
  };

  const reviewReady =
    !!sourceDir &&
    (!!destDir?.name || destDir?._drive || !HAS_DIR_PICKER) &&
    loadingComplete &&
    hasPhotos &&
    scoringComplete;

  const openDrivePicker = useCallback((target) => {
    if (driveConnecting) return;
    setDriveError(null);
    setDriveConnectLabel(target === 'export' ? 'export folder' : 'source folder');

    if (driveSessionReady.current) {
      setDrivePicker(target);
      return;
    }

    const clientId = driveConfigRef.current?.googleClientId;
    const scope = target === 'export' ? DRIVE_SCOPES.write : DRIVE_SCOPES.read;

    if (!driveAuthReady || !clientId || !window.google?.accounts?.oauth2) {
      setDriveError('Google sign-in is still loading. Wait a moment and try again.');
      return;
    }

    setDriveConnecting(true);
    requestDriveAccessFromGesture({ clientId, scope, prompt: '' })
      .then((accessToken) => authorizeDriveToken(accessToken))
      .then(() => {
        driveSessionReady.current = true;
        setDrivePicker(target);
      })
      .catch((err) => {
        if (err?.name !== 'AbortError') {
          setDriveError(err?.message || 'Google Drive authorization failed');
        }
      })
      .finally(() => {
        setDriveConnecting(false);
        setDriveConnectLabel('');
      });
  }, [driveAuthReady, driveConnecting]);

  const handleDriveFolderSelect = useCallback(({ id, name }) => {
    if (drivePicker === 'source') {
      clearPhotos();
      setSourceDir({ _drive: true, folderId: id, name });
    } else if (drivePicker === 'export') {
      setDestDir({ _drive: true, folderId: id, name });
    }
    setDrivePicker(null);
  }, [drivePicker, clearPhotos, setSourceDir, setDestDir]);

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
      <input
        ref={exportInputRef}
        type="file"
        webkitdirectory=""
        multiple
        style={{ display: 'none' }}
        onChange={handleExportInput}
      />
      <AppBar
        view={currentView}
        step={stepMap[currentView]}
        totalSteps={6}
        onHelp={() => setHelp(true)}
        projectName={sourceDir?.name || null}
      />
      {authExpired && (
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mono fs-xxs upper"
          style={{
            width: '100%',
            flexShrink: 0,
            padding: '10px 16px',
            border: 'none',
            borderBottom: '1px solid color-mix(in oklab, var(--reject) 35%, var(--line))',
            background: 'color-mix(in oklab, var(--reject) 18%, var(--bg-2))',
            color: 'var(--reject)',
            cursor: 'pointer',
            letterSpacing: '0.08em',
          }}
        >
          Session expired · reload to sign in
        </button>
      )}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed',
            bottom: 80,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 70,
            padding: '10px 18px',
            borderRadius: 10,
            background: 'var(--bg-2)',
            border: '1px solid var(--line)',
            boxShadow: 'var(--shadow-2)',
            fontSize: 'var(--fs-xs)',
            color: 'var(--fg)',
            animation: 'bbp-fade-in .25s var(--ease-out)',
            pointerEvents: 'none',
          }}
        >
          {toast.message}
        </div>
      )}
      <div style={{ flex: 1, position: 'relative', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <Routes>
          <Route path="/" element={<SessionHubView />} />
          <Route path="/one-off" element={
            <LandingView
              state={landingState}
              onSelectSource={pickSource}
              onSelectExport={pickExport}
              onSelectDriveSource={driveAvailable ? () => openDrivePicker('source') : undefined}
              onSelectDriveExport={driveAvailable ? () => openDrivePicker('export') : undefined}
              onBeginScoring={beginScoring}
              onBegin={() => navigate('/cull')}
              reviewReady={reviewReady}
              autonomousMode={autonomousMode}
              autoThreshold={autoThreshold}
              onThresholdChange={handleThresholdChange}
            />
          } />
          <Route path="/cull"    element={hasPhotos ? <CullingView feedbackIntensity="pronounced" showInlineKbd onComplete={() => navigate('/review')} /> : <Navigate to="/" />} />
          <Route path="/compare" element={hasPhotos ? <CompareView /> : <Navigate to="/" />} />
          <Route path="/edit"    element={hasPhotos ? <EditView /> : <Navigate to="/" />} />
          <Route path="/review"  element={hasPhotos ? <ReviewExportView /> : <Navigate to="/" />} />
          <Route path="/sessions" element={<Navigate to="/" replace />} />
          <Route path="/sessions/:sessionId" element={<SessionAreaView />} />
          <Route path="/sessions/:sessionId/favorites" element={<FavoritesReviewView />} />
          <Route path="/sessions/:sessionId/run/:runId" element={<RunView />} />
          <Route path="/review-queue" element={<ReviewQueueView />} />
        </Routes>
        {driveConnecting && (
          <div
            role="status"
            aria-live="polite"
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 90,
              background: 'rgba(0,0,0,.55)',
              display: 'grid',
              placeItems: 'center',
              padding: 'var(--sp-5)',
            }}
          >
            <div className="card" style={{ width: 'min(420px, 100%)', padding: 'var(--sp-6)', textAlign: 'center' }}>
              <div className="meta" style={{ marginBottom: 'var(--sp-3)' }}>Google Drive</div>
              <div className="fs-md" style={{ fontWeight: 600, marginBottom: 'var(--sp-3)' }}>
                Connecting to your {driveConnectLabel || 'folder'}
              </div>
              <p className="fs-sm" style={{ color: 'var(--fg-3)', lineHeight: 1.5, margin: 0 }}>
                Finish sign-in in the Google window if one opened. This page stays here while access is granted.
              </p>
            </div>
          </div>
        )}
        <GoogleDriveFolderPicker
          open={drivePicker != null}
          title={drivePicker === 'export' ? 'Choose export folder' : 'Choose source folder'}
          onClose={() => setDrivePicker(null)}
          onSelect={handleDriveFolderSelect}
        />
        <HelpOverlay open={help} onClose={handleCloseHelp} />
      </div>

      <nav style={{
        position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)',
        display: 'flex', gap: 4, padding: 4,
        background: 'color-mix(in oklab, var(--bg-2) 85%, transparent)',
        backdropFilter: 'blur(12px)', border: '1px solid var(--line)',
        borderRadius: 999, zIndex: 40, boxShadow: 'var(--shadow-2)',
      }}>
        {[
          ['/', 'Sessions', false],
          ['/cull', 'Cull', true],
          ['/compare', 'Compare', true],
          ['/review', 'Export', true],
        ].map(([path, label, needsPhotos]) => {
          const disabled = needsPhotos && !hasPhotos;
          const isActive = path === '/'
            ? (location.pathname === '/' || location.pathname.startsWith('/sessions'))
            : location.pathname === path;
          return (
            <button
              key={path}
              onClick={() => navigate(path)}
              disabled={disabled}
              title={disabled ? 'Select a source folder first' : undefined}
              className="mono fs-xxs upper"
              style={{
                padding: '8px 14px', borderRadius: 999,
                background: isActive ? 'var(--accent-soft)' : 'transparent',
                color: isActive ? 'var(--accent)' : disabled ? 'var(--fg-4)' : 'var(--fg-3)',
                opacity: disabled ? 0.45 : 1,
                cursor: disabled ? 'not-allowed' : 'pointer',
                transition: 'all .15s',
              }}
            >{label}</button>
          );
        })}
      </nav>
    </div>
  );
}

export default function App() {
  useEffect(() => {
    const r = document.documentElement;
    r.setAttribute('data-theme', 'surgical');
    r.setAttribute('data-density', 'comfortable');
  }, []);

  return (
    <Router>
      <Routes>
        <Route path="/gallery/:token" element={<GalleryShell />}>
          <Route index element={<GalleryGrid />} />
          <Route path="favorites" element={<GalleryFavorites />} />
          <Route path="photo/:photoId" element={<GalleryGrid />} />
        </Route>
        <Route
          path="/*"
          element={
            <GoogleGate>
              <AppContent />
            </GoogleGate>
          }
        />
      </Routes>
    </Router>
  );
}
