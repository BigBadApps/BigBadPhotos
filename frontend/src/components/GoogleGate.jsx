import { useState } from 'react';
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

function AuthGate({ onAuthed }) {
  const [state, setState] = useState('default');
  const [hint, setHint] = useState('');

  function trySignIn(scenario) {
    setState('loading');
    setHint('Verifying with provider…');
    setTimeout(() => {
      if (scenario === 'error') {
        setState('error');
        setHint("This account isn't on the allowlist. Contact the project owner to request access.");
      } else {
        setState('success');
        setHint('Authenticated. Loading workspace…');
        setTimeout(() => onAuthed(), 900);
      }
    }, 1000);
  }

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

          <button
            className="btn"
            onClick={() => trySignIn('ok')}
            disabled={state === 'loading' || state === 'success'}
            style={{
              width: '100%', height: 52,
              background: 'var(--bg-3)', color: 'var(--fg)',
              border: '1px solid var(--line-2)', borderRadius: 12,
              fontSize: 'var(--fs-md)', fontWeight: 600, gap: 12,
              transition: 'all .2s var(--ease-out)',
            }}
          >
            {state === 'loading' ? (
              <>
                <span style={{ width: 16, height: 16, borderRadius: '50%', border: '2px solid var(--line-2)', borderTopColor: 'var(--accent)', animation: 'bbp-spin .7s linear infinite', display: 'inline-block', flexShrink: 0 }} />
                <span>Authenticating…</span>
              </>
            ) : state === 'success' ? (
              <><Icon name="check" size={18} /><span>Authenticated</span></>
            ) : (
              <><GoogleMark size={20} /><span>Continue with Google</span></>
            )}
          </button>

          <div className="fs-xs dim" style={{ textAlign: 'center', lineHeight: 1.5 }}>
            You'll sign in with your Google account.<br />
            Only invited collaborators can access this workspace.
          </div>

          {hint && state !== 'default' && (
            <div style={{
              padding: '12px 14px', borderRadius: 10,
              border: '1px solid',
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

          {state === 'default' && (
            <div style={{ borderTop: '1px dashed var(--line)', paddingTop: 'var(--sp-4)', display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
              <span className="meta">Demo</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="chip" onClick={() => trySignIn('error')}>Try unauthorized</button>
                <button className="chip" onClick={() => trySignIn('ok')}>Try success</button>
              </div>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 16, alignItems: 'center', color: 'var(--fg-4)', fontSize: 'var(--fs-xxs)' }}>
          <span className="mono upper">BigBadPhotos &middot; Studio</span>
          <span>&middot;</span>
          <a href="#" style={{ color: 'var(--fg-3)' }}>Privacy</a>
          <span>&middot;</span>
          <a href="#" style={{ color: 'var(--fg-3)' }}>Status</a>
        </div>
      </div>
      <style>{`@keyframes bbp-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

export default function GoogleGate({ children }) {
  const [authed, setAuthed] = useState(false);
  if (authed) return children;
  return <AuthGate onAuthed={() => setAuthed(true)} />;
}
