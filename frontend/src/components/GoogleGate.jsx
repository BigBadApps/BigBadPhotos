import { useState, useEffect } from 'react';
import Icon from './Icon';

function GoogleMark({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="11" fill="currentColor" opacity=".08" />
      <circle cx="12" cy="12" r="11" fill="none" stroke="currentColor" strokeWidth="1.4" opacity=".55" />
      <path d="M12 7a5 5 0 1 0 4.6 7H12v-2.6h7.2c.1.5.2 1 .2 1.6 0 4.2-3 7-7.4 7A7.5 7.5 0 1 1 12 5c2 0 3.7.7 5 1.9l-2 2A4.7 4.7 0 0 0 12 7z" fill="currentColor" />
    </svg>
  );
}

function Spinner() {
  return (
    <span style={{
      width: 16, height: 16, borderRadius: '50%',
      border: '2px solid var(--line-2)', borderTopColor: 'var(--accent)',
      animation: 'bbp-spin .7s linear infinite',
      display: 'inline-block', flexShrink: 0,
    }} />
  );
}

function AuthGate({ onAuthed, authConfig }) {
  const [state, setState] = useState('default');
  const [hint, setHint] = useState('');
  const [password, setPassword] = useState('');

  async function tryPassword(e) {
    e?.preventDefault();
    if (!password.trim()) return;
    setState('loading');
    setHint('Verifying…');
    try {
      const res = await fetch('/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (res.ok) {
        setState('success');
        setHint('Authenticated. Loading workspace…');
        setTimeout(() => onAuthed(), 500);
      } else {
        setState('error');
        setHint(
          data.error === 'invalid_password'
            ? 'Incorrect password. Try again.'
            : 'Authentication failed — check server configuration.',
        );
      }
    } catch {
      setState('error');
      setHint('Could not reach the server. Is it running?');
    }
  }

  function tryDev() {
    setState('success');
    setHint('Dev mode — entering workspace…');
    setTimeout(() => onAuthed(), 400);
  }

  const busy = state === 'loading' || state === 'success';

  return (
    <div
      className="view"
      style={{
        minHeight: '100vh',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 'var(--sp-7)',
        background: 'radial-gradient(ellipse at 50% 30%, color-mix(in oklab, var(--accent) 8%, var(--bg)) 0%, var(--bg) 60%)',
        position: 'relative', overflow: 'hidden',
      }}
    >
      <div aria-hidden style={{
        position: 'absolute', inset: 0, opacity: .35,
        backgroundImage: 'linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px)',
        backgroundSize: '64px 64px',
        maskImage: 'radial-gradient(ellipse at center, black 0%, transparent 70%)',
      }} />

      <div style={{ position: 'relative', width: '100%', maxWidth: 420, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--sp-7)' }}>
        {/* Brand */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--sp-4)' }}>
          <div style={{
            width: 56, height: 56, borderRadius: 14,
            display: 'grid', placeItems: 'center',
            background: 'var(--bg-2)', border: '1px solid var(--line)',
            boxShadow: 'var(--accent-glow)',
          }}>
            <Icon name="aperture" size={28} />
          </div>
          <div style={{ textAlign: 'center' }}>
            <div className="meta" style={{ marginBottom: 6 }}>v0.4 &middot; Private Beta</div>
            <h1 style={{ margin: 0, fontSize: 'var(--fs-2xl)', fontWeight: 700, letterSpacing: 'var(--tracking-tight)' }}>BigBadPhotos</h1>
            <p style={{ margin: '8px 0 0', color: 'var(--fg-3)', fontSize: 'var(--fs-sm)' }}>The darkroom for serious culling.</p>
          </div>
        </div>

        {/* Card */}
        <div className="card card-elevated" style={{ width: '100%', padding: 'var(--sp-7)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-5)' }}>
          <div className="flex aic gap-3">
            <div style={{ width: 32, height: 32, borderRadius: 8, display: 'grid', placeItems: 'center', background: 'var(--bg-3)', border: '1px solid var(--line)' }}>
              <Icon name="lock" size={16} />
            </div>
            <div>
              <div className="meta">Restricted</div>
              <div className="fs-md" style={{ fontWeight: 600 }}>Sign in to continue</div>
            </div>
          </div>

          {/* Dev mode bypass */}
          {authConfig?.dev && (
            <button
              className="btn"
              onClick={tryDev}
              disabled={busy}
              style={{
                width: '100%', height: 52,
                background: 'color-mix(in oklab, var(--accent) 12%, var(--bg-3))',
                color: 'var(--fg)',
                border: '1px solid color-mix(in oklab, var(--accent) 30%, var(--line))',
                borderRadius: 12, fontSize: 'var(--fs-md)', fontWeight: 600, gap: 12,
              }}
            >
              {state === 'loading' ? <><Spinner /><span>Loading…</span></> : <><Icon name="aperture" size={18} /><span>Continue (Dev Mode)</span></>}
            </button>
          )}

          {/* Password form */}
          {authConfig?.password && (
            <form onSubmit={tryPassword} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
              <input
                type="password"
                value={password}
                onChange={e => { setPassword(e.target.value); if (state === 'error') setState('default'); }}
                placeholder="Enter access password"
                disabled={busy}
                autoFocus
                style={{
                  height: 48, padding: '0 14px', borderRadius: 10,
                  background: 'var(--bg-3)', border: `1px solid ${state === 'error' ? 'color-mix(in oklab, var(--reject) 60%, var(--line))' : 'var(--line)'}`,
                  color: 'var(--fg)', fontSize: 'var(--fs-md)',
                  outline: 'none', width: '100%',
                }}
              />
              <button
                type="submit"
                className="btn btn-primary"
                disabled={busy || !password.trim()}
                style={{ height: 52, width: '100%', fontSize: 'var(--fs-md)', fontWeight: 600, gap: 12 }}
              >
                {state === 'loading' ? <><Spinner /><span>Signing in…</span></>
                  : state === 'success' ? <><Icon name="check" size={18} /><span>Authenticated</span></>
                  : 'Sign In'}
              </button>
            </form>
          )}

          {/* Google OAuth (visual placeholder — requires @react-oauth/google + VITE_GOOGLE_CLIENT_ID) */}
          {authConfig?.google && !authConfig?.password && !authConfig?.dev && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
              <button
                className="btn"
                disabled
                style={{
                  width: '100%', height: 52,
                  background: 'var(--bg-3)', color: 'var(--fg)',
                  border: '1px solid var(--line-2)', borderRadius: 12,
                  fontSize: 'var(--fs-md)', fontWeight: 600, gap: 12,
                  opacity: .6,
                }}
              >
                <GoogleMark size={20} /><span>Continue with Google</span>
              </button>
              <p className="fs-xxs dim" style={{ textAlign: 'center' }}>
                Google OAuth requires <code>@react-oauth/google</code> — see AGENTS.md
              </p>
            </div>
          )}

          {/* No auth configured — open access */}
          {authConfig && !authConfig.dev && !authConfig.password && !authConfig.google && (
            <>
              <button
                className="btn btn-primary"
                onClick={() => onAuthed()}
                disabled={busy}
                style={{ width: '100%', height: 52, fontSize: 'var(--fs-md)', fontWeight: 600, gap: 12 }}
              >
                <Icon name="aperture" size={18} /><span>Enter Workspace</span>
              </button>
              <div style={{ padding: 'var(--sp-3)', borderRadius: 8, background: 'var(--bg-3)', border: '1px solid var(--line)' }}>
                <p className="meta" style={{ textAlign: 'center', color: 'var(--fg-3)' }}>
                  No auth configured — open access. Set <code>BBP_PASSWORD</code> or <code>BBP_DEBUG=1</code> to restrict.
                </p>
              </div>
            </>
          )}

          {/* Status hint */}
          {hint && (
            <div style={{
              padding: '12px 14px', borderRadius: 10, border: '1px solid',
              borderColor: state === 'error' ? 'color-mix(in oklab, var(--reject) 50%, var(--line))' : 'var(--line)',
              background: state === 'error' ? 'color-mix(in oklab, var(--reject) 8%, var(--bg-2))' : 'var(--bg-2)',
              display: 'flex', gap: 10, alignItems: 'flex-start',
            }}>
              <span style={{ color: state === 'error' ? 'var(--reject)' : state === 'success' ? 'var(--keep)' : 'var(--accent)', flexShrink: 0, marginTop: 1 }}>
                <Icon name={state === 'error' ? 'x' : state === 'success' ? 'check' : 'info'} size={14} />
              </span>
              <div className="fs-xs" style={{ color: 'var(--fg-2)', lineHeight: 1.5 }}>{hint}</div>
            </div>
          )}

          <div className="fs-xs dim" style={{ textAlign: 'center', lineHeight: 1.5 }}>
            Only invited collaborators can access this workspace.
          </div>
        </div>

        <div style={{ display: 'flex', gap: 16, alignItems: 'center', color: 'var(--fg-4)', fontSize: 'var(--fs-xxs)' }}>
          <span className="mono upper">BigBadPhotos &middot; Studio</span>
        </div>
      </div>

      <style>{`@keyframes bbp-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function Splash() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
        <div style={{ width: 48, height: 48, borderRadius: 12, display: 'grid', placeItems: 'center', background: 'var(--bg-2)', border: '1px solid var(--line)' }}>
          <Icon name="aperture" size={24} />
        </div>
        <div style={{ width: 80, height: 3, borderRadius: 99, overflow: 'hidden', background: 'var(--bg-3)' }}>
          <div style={{ width: '50%', height: '100%', background: 'var(--accent)', animation: 'bbp-slide 1.2s ease-in-out infinite' }} />
        </div>
      </div>
      <style>{`
        @keyframes bbp-slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(220%); } }
      `}</style>
    </div>
  );
}

export default function GoogleGate({ children }) {
  const [authed, setAuthed] = useState(false);
  const [checking, setChecking] = useState(true);
  const [authConfig, setAuthConfig] = useState(null);

  useEffect(() => {
    Promise.all([
      fetch('/auth/me').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/auth/config').then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([meData, configData]) => {
      if (configData) setAuthConfig(configData);
      if (meData?.authenticated || configData?.open) setAuthed(true);
    }).finally(() => setChecking(false));
  }, []);

  if (checking) return <Splash />;
  if (authed) return children;
  return <AuthGate onAuthed={() => setAuthed(true)} authConfig={authConfig} />;
}
