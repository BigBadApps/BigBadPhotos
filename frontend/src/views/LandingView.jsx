import { useEffect, useState } from 'react';
import Icon from '../components/Icon';
import { useStore } from '../store';

function formatEta(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `~${s}s remaining`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r > 0 ? `~${m}m ${r}s remaining` : `~${m}m remaining`;
}

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
        borderRadius: 12, textAlign: 'left', cursor: onPick ? 'pointer' : 'default',
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
      {onPick && <Icon name="arrowR" size={16} />}
    </button>
  );
}

export default function LandingView({
  state,
  onSelectSource,
  onSelectExport,
  onBeginScoring,
  onBegin,
  onSelectDriveSource,
  onSelectDriveExport,
  reviewReady = false,
}) {
  const {
    source = '', exportTarget = '', total = 0, fileType = '—',
    scored = 0, scoreableCount = 0, isLoading = false,
    loadingComplete = false, loadedCount = 0, loadError = null,
    scoring = false, scoreError = null, backendAvailable = true,
    authExpired = false, hasPhotos = false,
    etaSeconds = null, scoringStarted = false, scoringComplete = true,
    driveError = null,
    driveAvailable = false,
    driveConnecting = false,
    driveAuthReady = false,
    dev = false,
  } = state || {};

  const scoringPct = scoreableCount > 0
    ? Math.round((scored / scoreableCount) * 100)
    : 0;
  const loadPct = total > 0 ? Math.round((loadedCount / total) * 100) : 0;
  const etaLabel = formatEta(etaSeconds);
  const showBeginAiScoring =
    !!source
    && loadingComplete
    && !isLoading
    && hasPhotos
    && scoreableCount > 0
    && !scoring
    && !(scoringPct === 100 && scoringStarted);

  const [heroPhotoId, setHeroPhotoId] = useState(null);
  const previewableCount = useStore((s) => {
    let count = 0;
    for (const id of s.order) {
      if (s.photos[id]?.url) count += 1;
    }
    return count;
  });

  useEffect(() => {
    setHeroPhotoId(null);
  }, [source]);

  useEffect(() => {
    if (!source || previewableCount === 0) return;
    const { order, photos } = useStore.getState();
    const ids = order.filter((id) => photos[id]?.url);
    if (ids.length === 0) return;
    setHeroPhotoId((prev) => {
      if (prev && ids.includes(prev)) return prev;
      return ids[Math.floor(Math.random() * ids.length)];
    });
  }, [source, previewableCount]);

  const heroUrl = useStore((s) => (heroPhotoId ? s.photos[heroPhotoId]?.url : null));

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
        {/* Hero panel */}
        <div style={{
          position: 'relative', borderRadius: 14, overflow: 'hidden',
          background: 'var(--bg-2)', border: '1px solid var(--line)',
          minHeight: 480, display: 'flex', flexDirection: 'column',
        }}>
          <div style={{
            position: 'relative',
            width: '100%', flex: 1, minHeight: 0,
            background: 'repeating-linear-gradient(135deg, rgba(255,255,255,.025) 0 2px, transparent 2px 14px), var(--bg-3)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {heroUrl ? (
              <>
                <img
                  src={heroUrl}
                  alt=""
                  decoding="async"
                  draggable={false}
                  style={{
                    position: 'absolute',
                    inset: 0,
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                  }}
                />
                <div
                  aria-hidden
                  style={{
                    position: 'absolute',
                    inset: 0,
                    background: 'linear-gradient(to top, rgba(0,0,0,.55) 0%, transparent 45%), repeating-linear-gradient(135deg, rgba(255,255,255,.02) 0 2px, transparent 2px 14px)',
                    pointerEvents: 'none',
                  }}
                />
              </>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, color: 'var(--fg-3)' }}>
                <Icon name="image" size={40} stroke={1.2} />
                <span className="meta">
                  {!source && 'Select a source folder to get started'}
                  {source && isLoading && 'Loading preview…'}
                  {source && !isLoading && loadingComplete && !heroUrl
                    && 'No browser preview (RAW-only or unsupported formats)'}
                </span>
              </div>
            )}
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
                {source
                  ? isLoading ? 'Loading…'
                  : loadingComplete ? 'Ready to cull.'
                  : 'Choose your shoot.'
                  : 'Choose your shoot.'}
              </h1>
              <p style={{ margin: '12px 0 0', color: 'var(--fg-2)', fontSize: 'var(--fs-md)', maxWidth: '40ch' }}>
                {source && loadingComplete
                  ? `${total.toLocaleString()} photos loaded${
                    scoreableCount > 0
                      ? (scoring
                        ? ' · AI scoring in progress'
                        : scoringPct === 100 && scoringStarted
                          ? ' · AI scoring complete'
                          : scoringStarted
                            ? ''
                            : ' · run AI scoring when ready')
                      : ' · RAW files'
                  }.`
                  : source && isLoading
                  ? `Loading photos from ${source}…`
                  : 'Pick a local or Google Drive source folder, set an export target, and step into the darkroom.'}
              </p>
            </div>
            <div className="meta" style={{ flexShrink: 0, textAlign: 'right' }}>
              <div>{new Date().toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })}</div>
              <div style={{ marginTop: 4, color: 'var(--fg-4)' }}>local &middot; {fileType.toLowerCase()}</div>
            </div>
          </div>

          <div style={{
            position: 'absolute', top: 'var(--sp-5)', left: 'var(--sp-5)',
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
            background: 'rgba(0,0,0,.5)', border: '1px solid rgba(255,255,255,.1)',
            borderRadius: 999, backdropFilter: 'blur(8px)',
          }} className="meta">
            <span style={{
              width: 6, height: 6, borderRadius: 99,
              background: isLoading ? 'var(--warning)' : loadingComplete && hasPhotos ? 'var(--accent)' : 'var(--fg-4)',
              boxShadow: loadingComplete && hasPhotos ? '0 0 8px var(--accent)' : 'none',
            }} />
            <span style={{ color: 'var(--fg-2)' }}>
              {isLoading ? 'Loading' : loadingComplete && hasPhotos ? 'Ready' : 'No session'}
            </span>
          </div>
        </div>

        {/* Controls column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gap)', minWidth: 0 }}>
          
          <div className="card" style={{ padding: 'var(--sp-5)' }}>
            <div className="meta" style={{ marginBottom: 'var(--sp-4)' }}>Session folders</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
              <FolderRow kind="Source" label="Select local folder" value={source} onPick={onSelectSource} accent={!source} />
              {onSelectDriveSource && (
                <button type="button" className="btn btn-secondary btn-uppercase" onClick={onSelectDriveSource} disabled={driveConnecting || !driveAuthReady}>
                  {driveConnecting ? 'Connecting to Google Drive…' : !driveAuthReady ? 'Preparing Google Drive…' : 'Choose Google Drive source'}
                </button>
              )}
              <FolderRow kind="Export Target" label="Select local export folder" value={exportTarget} onPick={onSelectExport} />
              {onSelectDriveExport && (
                <button type="button" className="btn btn-secondary btn-uppercase" onClick={onSelectDriveExport} disabled={driveConnecting || !driveAuthReady}>
                  {driveConnecting ? 'Connecting to Google Drive…' : !driveAuthReady ? 'Preparing Google Drive…' : 'Choose Google Drive export folder'}
                </button>
              )}
            </div>
            {!driveAvailable && dev && (
              <div className="fs-xs" style={{ color: 'var(--fg-3)', marginTop: 'var(--sp-3)' }}>
                Google Drive needs <span className="mono">GOOGLE_CLIENT_ID</span> in <span className="mono">.env</span> or <span className="mono">frontend/.env.local</span>, the Drive API enabled in Google Cloud, and a Flask restart on port 8002.
              </div>
            )}
            {driveError && (
              <div className="fs-xs" style={{ color: 'var(--reject)', marginTop: 'var(--sp-3)' }}>
                {driveError}
              </div>
            )}
          </div>

          {/* Library / progress card */}
          {source && (
            <div className="card" style={{ padding: 'var(--sp-5)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
              <div className="flex jcsb aic">
                <div className="meta">Library</div>
                {loadError && <span className="fs-xxs" style={{ color: 'var(--reject)' }}>Error loading</span>}
              </div>

              {/* Loading progress */}
              {isLoading && (
                <div>
                  <div className="flex jcsb aic" style={{ marginBottom: 8 }}>
                    <span className="meta">Loading photos</span>
                    <span className="mono fs-xs" style={{ color: 'var(--fg-2)' }}>
                      {total > 0 ? `${loadedCount} / ${total}` : 'Scanning…'}
                    </span>
                  </div>
                  <div style={{ height: 4, background: 'var(--bg-4)', borderRadius: 2, overflow: 'hidden' }}>
                    {total > 0 ? (
                      <div style={{ height: '100%', width: `${loadPct}%`, background: 'var(--fg-3)', transition: 'width .4s var(--ease-out)', borderRadius: 2 }} />
                    ) : (
                      <div style={{ height: '100%', width: '35%', background: 'var(--fg-3)', borderRadius: 2, animation: 'bbp-scan 1.4s ease-in-out infinite' }} />
                    )}
                  </div>
                </div>
              )}

              {/* Photo stats */}
              {!isLoading && loadingComplete && hasPhotos && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--sp-3)' }}>
                  <Stat label="Photos" value={total.toLocaleString()} />
                  <Stat label="Format" value={fileType} />
                </div>
              )}

              {/* No photos found */}
              {!isLoading && loadingComplete && !hasPhotos && (
                <div className="fs-xs dim" style={{ color: 'var(--fg-3)' }}>
                  No supported images found in this folder.
                </div>
              )}

              {/* AI scoring (only after user starts scoring, or finished / errored a run) */}
              {!isLoading && loadingComplete && scoreableCount > 0 && scoringStarted && (
                <div style={{ paddingTop: 'var(--sp-3)', borderTop: '1px dashed var(--line)' }}>
                  <div className="flex jcsb aic" style={{ marginBottom: 8 }}>
                    <span className="meta">AI Scoring</span>
                    <div className="flex aic" style={{ gap: 8 }}>
                      {scoring && etaLabel && (
                        <span className="mono fs-xxs" style={{ color: 'var(--fg-3)' }}>{etaLabel}</span>
                      )}
                      <span className="mono fs-xs" style={{ color: scoringPct === 100 ? 'var(--keep)' : scoring ? 'var(--accent)' : 'var(--fg-2)' }}>
                        {scoringPct}%
                      </span>
                    </div>
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
                      ? `All ${scored} photos scored · ready for review`
                      : scoring
                      ? `${scored} of ${scoreableCount} · scoring…`
                      : authExpired
                      ? (
                        <span>
                          Session expired &middot;{' '}
                          <span
                            style={{ color: 'var(--accent)', cursor: 'pointer', textDecoration: 'underline' }}
                            onClick={() => window.location.reload()}
                          >
                            reload to sign in
                          </span>
                        </span>
                      )
                      : scoreError
                      ? `Scoring error · ${backendAvailable ? scoreError : 'backend unavailable'}`
                      : !backendAvailable
                      ? 'Backend offline · culling without scores'
                      : `${scored} of ${scoreableCount} scored`}
                  </div>
                </div>
              )}

              {/* RAW-only notice */}
              {!isLoading && loadingComplete && scoreableCount === 0 && hasPhotos && (
                <div className="fs-xxs dim mono upper" style={{ paddingTop: 'var(--sp-3)', borderTop: '1px dashed var(--line)' }}>
                  RAW-only session · manual culling
                </div>
              )}
            </div>
          )}

          {/* Begin AI scoring — after load, before / during first scoring run */}
          {showBeginAiScoring && onBeginScoring && (
            <button
              type="button"
              className="btn btn-ghost btn-uppercase"
              onClick={onBeginScoring}
              style={{ height: 56, fontSize: 'var(--fs-sm)' }}
            >
              <span>Begin AI Scoring</span>
              <Icon name="arrowR" size={16} />
            </button>
          )}

          {/* Begin review — only when export is set and scoring is done (or RAW-only) */}
          <button
            className="btn btn-primary btn-uppercase"
            onClick={onBegin}
            disabled={!reviewReady}
            style={{ height: 56, fontSize: 'var(--fs-sm)', opacity: reviewReady ? 1 : 0.55 }}
          >
            <span>Begin Review</span>
            <Icon name="arrowR" size={16} />
          </button>

          {!source && (
            <div className="fs-xxs dim mono upper ta-c">Pick a source folder to continue</div>
          )}
          {source && !exportTarget && !isLoading && (
            <div className="fs-xxs dim mono upper ta-c">Set an export target to enable</div>
          )}
          {source && exportTarget && isLoading && (
            <div className="fs-xxs dim mono upper ta-c">Loading photos…</div>
          )}
          {source && exportTarget && loadingComplete && !hasPhotos && (
            <div className="fs-xxs dim mono upper ta-c">No photos found in folder</div>
          )}
          {source && exportTarget && loadingComplete && hasPhotos && scoreableCount > 0 && !scoringComplete && (
            <div className="fs-xxs dim mono upper ta-c">
              {scoringStarted ? 'Finish AI scoring to begin review' : 'Start AI scoring to rank photos before review'}
            </div>
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
        @keyframes bbp-scan {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(350%); }
        }
      `}</style>
    </div>
  );
}
