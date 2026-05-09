import Icon from '../components/Icon';

function Stat({ label, value, sub }) {
  return (
    <div className="stat">
      <div className="meta">{label}</div>
      <div className="stat-num">{value}</div>
      {sub && <div className="fs-xxs dim mono upper" style={{ marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function FolderRow({ kind, label, value, onPick, accent }) {
  return (
    <button
      onClick={onPick}
      style={{
        display: 'flex', alignItems: 'center', gap: 14,
        width: '100%', padding: 'var(--sp-4) var(--sp-5)',
        background: value ? 'var(--bg-3)' : 'var(--bg-2)',
        border: `1px solid ${accent ? 'color-mix(in oklab, var(--accent) 40%, var(--line))' : 'var(--line)'}`,
        borderRadius: 12, textAlign: 'left', cursor: 'pointer',
        transition: 'all .2s var(--ease-out)',
      }}
    >
      <div style={{
        width: 40, height: 40, borderRadius: 10,
        display: 'grid', placeItems: 'center',
        background: accent ? 'var(--accent-soft)' : 'var(--bg-3)',
        color: accent ? 'var(--accent)' : 'var(--fg-2)',
        flexShrink: 0,
      }}>
        <Icon name={value ? 'folderOpen' : 'folder'} size={18} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="meta">{kind}</div>
        <div className="fs-sm" style={{
          fontWeight: 500, marginTop: 2,
          color: value ? 'var(--fg)' : 'var(--fg-3)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{value || label}</div>
      </div>
      <Icon name="arrowR" size={16} />
    </button>
  );
}

export default function LandingView({ state, onSelectSource, onSelectExport, onBegin, onSimulateScoring }) {
  const { source = '', exportTarget = '', total = 1247, fileType = 'RAW + JPG', scored = 0 } = state || {};
  const ready = !!source && !!exportTarget;
  const scoringPct = total ? Math.round((scored / total) * 100) : 0;

  return (
    <div className="view">
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)',
          gap: 'var(--gap)', padding: 'var(--pad)', flex: 1, minHeight: 0,
        }}
        className="landing-grid"
      >
        {/* Hero */}
        <div style={{
          position: 'relative', borderRadius: 14, overflow: 'hidden',
          background: 'var(--bg-2)', border: '1px solid var(--line)',
          minHeight: 480, display: 'flex', flexDirection: 'column',
        }}>
          <div style={{
            width: '100%', flex: 1,
            background: 'repeating-linear-gradient(135deg, rgba(255,255,255,.025) 0 2px, transparent 2px 14px), var(--bg-3)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, color: 'var(--fg-3)' }}>
              <Icon name="image" size={40} stroke={1.2} />
              <span className="meta">Drop your first photo here &middot; or any reference image</span>
            </div>
          </div>

          <div style={{
            position: 'absolute', inset: 'auto 0 0 0',
            padding: 'var(--sp-7)',
            background: 'linear-gradient(to top, rgba(0,0,0,.85), transparent)',
            display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
            gap: 'var(--sp-5)',
          }}>
            <div>
              <div className="meta" style={{ color: 'var(--accent)', marginBottom: 8 }}>&middot; Session</div>
              <h1 style={{ margin: 0, fontSize: 'clamp(28px, 4vw, 48px)', fontWeight: 700, letterSpacing: 'var(--tracking-tight)', lineHeight: 1.05, maxWidth: '20ch' }}>
                {source ? 'Ready to cull.' : 'Choose your shoot.'}
              </h1>
              <p style={{ margin: '12px 0 0', color: 'var(--fg-2)', fontSize: 'var(--fs-md)', maxWidth: '40ch' }}>
                {source
                  ? `${total.toLocaleString()} photos detected. Scoring engine ready.`
                  : 'Pick a source folder, set an export target, and step into the darkroom.'}
              </p>
            </div>
            <div className="meta" style={{ flexShrink: 0, textAlign: 'right' }}>
              <div>{new Date().toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })}</div>
              <div style={{ marginTop: 4, color: 'var(--fg-4)' }}>local &middot; raw + jpg</div>
            </div>
          </div>

          <div style={{
            position: 'absolute', top: 'var(--sp-5)', left: 'var(--sp-5)',
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
            background: 'rgba(0,0,0,.5)', border: '1px solid rgba(255,255,255,.1)',
            borderRadius: 999, backdropFilter: 'blur(8px)',
          }} className="meta">
            <span style={{ width: 6, height: 6, borderRadius: 99, background: 'var(--accent)', boxShadow: '0 0 8px var(--accent)' }} />
            <span style={{ color: 'var(--fg-2)' }}>Hero &middot; Drop to set</span>
          </div>
        </div>

        {/* Controls */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gap)', minWidth: 0 }}>
          <div className="card" style={{ padding: 'var(--sp-5)' }}>
            <div className="meta" style={{ marginBottom: 'var(--sp-4)' }}>Folders</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
              <FolderRow kind="Source" label="Select source folder" value={source} onPick={onSelectSource} accent={!source} />
              <FolderRow kind="Export Target" label="Where keepers go" value={exportTarget} onPick={onSelectExport} />
            </div>
          </div>

          {source && (
            <div className="card" style={{ padding: 'var(--sp-5)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
              <div className="flex jcsb aic">
                <div className="meta">Library</div>
                {scoringPct < 100 && (
                  <button className="chip" onClick={onSimulateScoring}>
                    <Icon name="sparkle" size={11} />
                    {scoringPct === 0 ? 'Begin scoring' : 'Resume scoring'}
                  </button>
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--sp-3)' }}>
                <Stat label="Photos" value={total.toLocaleString()} />
                <Stat label="Format" value={fileType} sub="Mixed" />
              </div>
              <div style={{ paddingTop: 'var(--sp-3)', borderTop: '1px dashed var(--line)' }}>
                <div className="flex jcsb aic" style={{ marginBottom: 8 }}>
                  <span className="meta">AI Scoring</span>
                  <span className="mono fs-xs" style={{ color: scoringPct === 100 ? 'var(--keep)' : 'var(--fg-2)' }}>{scoringPct}%</span>
                </div>
                <div style={{ height: 6, background: 'var(--bg-4)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', width: `${scoringPct}%`,
                    background: scoringPct === 100 ? 'var(--keep)' : 'var(--accent)',
                    boxShadow: scoringPct === 100 ? 'none' : '0 0 12px var(--accent-soft)',
                    transition: 'width .6s var(--ease-out)',
                  }} />
                </div>
                <div className="fs-xxs dim mono upper" style={{ marginTop: 6 }}>
                  {scoringPct === 100
                    ? `All ${scored} photos scored · ready to begin`
                    : `${scored} of ${total} scored`}
                </div>
              </div>
            </div>
          )}

          <button
            className="btn btn-primary btn-uppercase"
            onClick={onBegin}
            disabled={!ready || scoringPct < 25}
            style={{ height: 56, fontSize: 'var(--fs-sm)' }}
          >
            <span>Begin Review</span>
            <Icon name="arrowR" size={16} />
          </button>
          {!ready && (
            <div className="fs-xxs dim mono upper ta-c">
              {!source ? 'Pick a source folder to continue' : 'Set an export target to enable'}
            </div>
          )}
          {ready && scoringPct < 25 && (
            <div className="fs-xxs dim mono upper ta-c">Run AI scoring to enable review</div>
          )}
        </div>
      </div>

      <style>{`
        @media (max-width: 900px) {
          .landing-grid { grid-template-columns: 1fr !important; }
          .landing-grid > div:first-child { min-height: 380px !important; }
        }
        @media (max-width: 520px) {
          .landing-grid > div:first-child { min-height: 320px !important; }
        }
      `}</style>
    </div>
  );
}
