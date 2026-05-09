import { useState, useEffect, useCallback } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import GoogleGate from './components/GoogleGate';
import AppBar from './components/AppBar';
import HelpOverlay from './components/HelpOverlay';
import LandingView from './views/LandingView';
import CullingView from './views/CullingView';
import CompareView from './views/CompareView';
import ReviewExportView from './views/ReviewExportView';

function AppContent() {
  const navigate = useNavigate();
  const location = useLocation();
  const [help, setHelp] = useState(false);
  const [landing, setLanding] = useState({
    source: '',
    exportTarget: '',
    total: 1247,
    fileType: 'RAW + JPG',
    scored: 0,
  });

  const currentView = location.pathname === '/' ? 'landing'
    : location.pathname === '/cull' ? 'culling'
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

  const simulateScoring = useCallback(() => {
    const id = setInterval(() => {
      setLanding(s => {
        if (s.scored >= s.total) { clearInterval(id); return s; }
        const inc = Math.max(20, Math.round(s.total * 0.05));
        return { ...s, scored: Math.min(s.scored + inc, s.total) };
      });
    }, 180);
  }, []);

  function pickSource() {
    setLanding(s => ({ ...s, source: '~/Pictures/2026-05-09 Session' }));
  }
  function pickExport() {
    setLanding(s => ({ ...s, exportTarget: '~/Exports/Session · Selects' }));
  }

  return (
    <div className="app-root">
      <AppBar
        view={currentView}
        step={stepMap[currentView]}
        totalSteps={5}
        onHelp={() => setHelp(true)}
        projectName={landing.source ? landing.source.split('/').pop() : null}
      />
      <div style={{ flex: 1, position: 'relative', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <Routes>
          <Route path="/" element={
            <LandingView
              state={landing}
              onSelectSource={pickSource}
              onSelectExport={pickExport}
              onSimulateScoring={simulateScoring}
              onBegin={() => navigate('/cull')}
            />
          } />
          <Route path="/cull" element={
            landing.source
              ? <CullingView feedbackIntensity="pronounced" showInlineKbd onComplete={() => navigate('/review')} />
              : <Navigate to="/" />
          } />
          <Route path="/compare" element={landing.source ? <CompareView /> : <Navigate to="/" />} />
          <Route path="/review"  element={landing.source ? <ReviewExportView /> : <Navigate to="/" />} />
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
        {[['/', 'Landing'], ['/cull', 'Culling']].map(([path, label]) => (
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
