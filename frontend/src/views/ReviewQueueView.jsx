import { useState, useEffect, useCallback, useRef } from 'react';
import Icon from '../components/Icon';
import * as sessionsClient from '../api/sessionsClient';

function scoreColor(score) {
  return score >= 0.75 ? 'var(--keep)' : score >= 0.5 ? 'var(--warning)' : 'var(--reject)';
}

/** Inline variant of the `.culling-view` mobile breakpoint (index.css owns the real one). */
function useIsMobile(maxWidth = 900) {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia(`(max-width: ${maxWidth}px)`).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const onChange = (e) => setIsMobile(e.matches);
    mq.addEventListener('change', onChange);
    setIsMobile(mq.matches);
    return () => mq.removeEventListener('change', onChange);
  }, [maxWidth]);
  return isMobile;
}

function Thumb({ photo, active, onClick }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={photo.filename || `photo ${photo.id}`}
      aria-current={active ? 'true' : undefined}
      style={{
        position: 'relative', aspectRatio: '1', padding: 0, width: '100%',
        borderRadius: 8, overflow: 'hidden', cursor: 'pointer',
        background: 'var(--bg-3)',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--line)'}`,
        boxShadow: active ? '0 0 0 2px var(--accent)' : 'none',
        transition: 'border-color .15s, box-shadow .15s',
      }}
    >
      {!loaded && (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'var(--fg-4)' }}>
          <Icon name="image" size={20} />
        </div>
      )}
      <img
        src={`/photos/${photo.id}/thumb`}
        alt={photo.filename || ''}
        draggable={false}
        onLoad={() => setLoaded(true)}
        onError={() => setLoaded(false)}
        style={{
          width: '100%', height: '100%', objectFit: 'cover', display: 'block',
          opacity: loaded ? 1 : 0, transition: 'opacity .2s',
        }}
      />
      <div style={{
        position: 'absolute', left: 0, right: 0, bottom: 0,
        padding: '10px 6px 5px',
        background: 'linear-gradient(transparent, rgba(0,0,0,.72))',
        display: 'flex', alignItems: 'center',
      }}>
        <span className="mono" style={{
          fontSize: 9, color: 'var(--fg)', lineHeight: 1.2,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {photo.filename || `photo ${photo.id}`}
        </span>
      </div>
      {photo.overallScore != null && (
        <span style={{
          position: 'absolute', top: 6, right: 6, padding: '2px 5px', borderRadius: 4,
          background: 'rgba(0,0,0,.72)', fontFamily: 'var(--font-mono)', fontSize: 9,
          fontWeight: 600, color: scoreColor(photo.overallScore),
        }}>
          {Math.round(photo.overallScore * 100)}
        </span>
      )}
    </button>
  );
}

function EmptyState({ icon, title, body, onRefresh, refreshing }) {
  return (
    <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 'var(--pad)' }}>
      <div className="card" style={{ padding: 'var(--sp-7)', maxWidth: 420, textAlign: 'center' }}>
        <div style={{
          width: 56, height: 56, borderRadius: 999, margin: '0 auto var(--sp-4)',
          display: 'grid', placeItems: 'center',
          background: 'color-mix(in oklab, var(--accent) 12%, var(--bg-3))',
          color: 'var(--accent)',
        }}>
          <Icon name={icon} size={26} stroke={1.4} />
        </div>
        <div className="fs-md" style={{ fontWeight: 600, marginBottom: 'var(--sp-2)' }}>{title}</div>
        <p className="fs-sm" style={{ color: 'var(--fg-3)', lineHeight: 1.6, margin: '0 0 var(--sp-5)' }}>{body}</p>
        <button type="button" className="btn btn-ghost btn-uppercase" onClick={onRefresh} disabled={refreshing} style={{ height: 40 }}>
          <Icon name="undo" size={13} />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
    </div>
  );
}

export default function ReviewQueueView() {
  const [status, setStatus] = useState('loading'); // 'loading' | 'no-run' | 'error' | 'ready'
  const [runId, setRunId] = useState(null);
  const [sessionName, setSessionName] = useState(null);
  const [photos, setPhotos] = useState([]);
  const [loadingPhotos, setLoadingPhotos] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const isMobile = useIsMobile();

  // Serializes keep/reject/approve-all requests so a rollback snapshot is always
  // the committed queue: a failed request can never clobber an in-between decision.
  const inFlightRef = useRef(false);
  // A P/R press that lands while a decision is in flight isn't dropped — it's
  // remembered here and replayed the moment the in-flight one settles, so fast
  // keyboard review never silently loses a keystroke. Most-recent-wins if
  // several land in the same window (e.g. held-down key repeat).
  const pendingDecisionRef = useRef(null);
  const toastTimerRef = useRef(null);
  // Mirror of `photos` kept in a ref so a stale closure (a handler created before
  // the last render committed) still snapshots the current committed queue.
  const photosRef = useRef([]);

  useEffect(() => { photosRef.current = photos; }, [photos]);

  useEffect(() => () => window.clearTimeout(toastTimerRef.current), []);

  const showToast = useCallback((msg) => {
    setToast(msg);
    window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 1800);
  }, []);

  const refreshPhotos = useCallback(async (rid) => {
    setLoadingPhotos(true);
    try {
      const data = await sessionsClient.listPhotos(rid, { state: 'awaiting_review' });
      const ps = Array.isArray(data.photos) ? data.photos : [];
      setPhotos(ps);
      setSelectedId((prev) => (prev != null && ps.some((p) => p.id === prev) ? prev : (ps[0]?.id ?? null)));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingPhotos(false);
    }
  }, []);

  const load = useCallback(async (initial = false) => {
    if (initial) setStatus('loading');
    setError(null);
    try {
      const st = await sessionsClient.activeRun();
      if (!st.running || st.runId == null) {
        setStatus('no-run');
        setRunId(null);
        setSessionName(null);
        setPhotos([]);
        setSelectedId(null);
        return;
      }
      setRunId(st.runId);
      setSessionName(st.sessionName || null);
      setStatus('ready');
      await refreshPhotos(st.runId);
    } catch (err) {
      setError(err.message);
      if (initial) setStatus('error');
    }
  }, [refreshPhotos]);

  useEffect(() => {
    load(true);
  }, [load]);

  // While the run is live but the queue is empty (e.g. photos are still being
  // scored), quietly poll so newly-arrived photos show up on their own.
  useEffect(() => {
    if (status !== 'ready' || photos.length > 0 || loadingPhotos || !runId) return undefined;
    const t = window.setInterval(() => refreshPhotos(runId), 5000);
    return () => window.clearInterval(t);
  }, [status, photos.length, loadingPhotos, runId, refreshPhotos]);

  const handleDecision = useCallback(async (photo, decision) => {
    if (inFlightRef.current) {
      // Don't drop it — remember it and replay once the in-flight one settles.
      pendingDecisionRef.current = { photo, decision };
      return;
    }
    inFlightRef.current = true;
    pendingDecisionRef.current = null;
    const prevPhotos = photosRef.current; // snapshot of the committed queue before this decision
    const idx = prevPhotos.findIndex((p) => p.id === photo.id);
    const nextId = idx >= 0
      ? (prevPhotos[idx + 1]?.id ?? prevPhotos[idx - 1]?.id ?? null)
      : null;
    setPhotos((ps) => ps.filter((p) => p.id !== photo.id)); // optimistic removal
    setSelectedId((prev) => (prev === photo.id ? nextId : prev)); // advance the lightbox in place
    try {
      await sessionsClient.decide(photo.id, decision);
      showToast(decision === 'keep' ? 'Kept' : 'Rejected');
    } catch (err) {
      setPhotos(prevPhotos); // rollback to the exact snapshot
      setError(err.message);
    } finally {
      inFlightRef.current = false;
      const queued = pendingDecisionRef.current;
      if (queued) {
        pendingDecisionRef.current = null;
        handleDecision(queued.photo, queued.decision);
      }
    }
  }, [showToast]);

  const handleApproveAll = useCallback(async () => {
    if (!runId || inFlightRef.current) return;
    inFlightRef.current = true;
    setApproving(true);
    const prevPhotos = photosRef.current; // snapshot before the bulk clear
    setPhotos([]); // optimistic: the whole queue clears instantly
    try {
      const { count } = await sessionsClient.approveAll(runId);
      setConfirmApprove(false);
      showToast(`Approved ${count} photo${count === 1 ? '' : 's'}`);
    } catch (err) {
      setPhotos(prevPhotos); // rollback to the exact snapshot
      setConfirmApprove(false);
      setError(err.message);
    } finally {
      inFlightRef.current = false;
      setApproving(false);
    }
  }, [runId, showToast]);

  const advance = useCallback((dir) => {
    if (photos.length === 0) return;
    if (selectedId == null) { setSelectedId(photos[0].id); return; }
    const ids = photos.map((p) => p.id);
    const i = ids.indexOf(selectedId);
    const next = (i === -1 ? 0 : (i + dir + ids.length) % ids.length);
    setSelectedId(ids[next]);
  }, [photos, selectedId]);

  const currentPhoto = photos.length === 0
    ? null
    : photos.find((p) => p.id === (selectedId ?? photos[0].id)) ?? photos[0];

  useEffect(() => {
    function onKey(e) {
      if (e.repeat) return;
      if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return;
      const k = e.key.toLowerCase();
      if (k === 'escape') { setSelectedId(null); setConfirmApprove(false); return; }
      if (confirmApprove) return; // confirm modal is open — don't decide behind it
      if (k === 'p' && currentPhoto) { e.preventDefault(); handleDecision(currentPhoto, 'keep'); }
      else if (k === 'r' && currentPhoto) { e.preventDefault(); handleDecision(currentPhoto, 'reject'); }
      else if (k === 'arrowright' && currentPhoto) { e.preventDefault(); advance(1); }
      else if (k === 'arrowleft' && currentPhoto) { e.preventDefault(); advance(-1); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentPhoto, handleDecision, advance, confirmApprove]);

  const showEmpty = status === 'ready' && !loadingPhotos && photos.length === 0;

  return (
    <div className="view" style={{
      flex: 1, minHeight: 0,
      // Clear the app's floating bottom nav on phones (matches `.culling-view`).
      paddingBottom: isMobile ? 'calc(76px + env(safe-area-inset-bottom, 0px))' : undefined,
    }}>
      {/* Header */}
      <header style={{ padding: 'var(--pad) var(--pad) 0', flexShrink: 0 }}>
        <div className="meta" style={{ color: 'var(--accent)', marginBottom: 8 }}>· Review Queue</div>
        <div className="flex jcsb aic" style={{ gap: 12, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <h1 style={{ margin: 0, fontSize: 'clamp(28px, 4vw, 40px)', fontWeight: 700, letterSpacing: 'var(--tracking-tight)', lineHeight: 1.05 }}>
              Review queue
            </h1>
            <p className="fs-sm" style={{ margin: '8px 0 0', color: 'var(--fg-3)' }}>
              {status === 'no-run' && 'No active session'}
              {status !== 'no-run' && sessionName && <>Session · <span style={{ color: 'var(--fg-2)' }}>{sessionName}</span></>}
              {status !== 'no-run' && !sessionName && 'Drive-backed keep / reject'}
              {photos.length > 0 && <span style={{ color: 'var(--fg-4)' }}> · {photos.length} awaiting review</span>}
            </p>
          </div>
          {status === 'ready' && (
            <div className="flex aic" style={{ gap: 8 }}>
              <button type="button" className="btn btn-ghost btn-uppercase" onClick={() => load(false)} disabled={loadingPhotos} style={{ height: 40, fontSize: 'var(--fs-xxs)' }}>
                <Icon name="undo" size={13} />
                {loadingPhotos ? 'Refreshing…' : 'Refresh'}
              </button>
              {photos.length > 0 && (
                <button type="button" className="btn btn-primary btn-uppercase" onClick={() => setConfirmApprove(true)} style={{ height: 40, fontSize: 'var(--fs-xxs)' }}>
                  <Icon name="check" size={13} />
                  Approve all ({photos.length})
                </button>
              )}
            </div>
          )}
        </div>
      </header>

      {/* Error banner */}
      {error && (
        <div className="flex jcsb aic" style={{
          margin: 'var(--sp-4) var(--pad) 0', gap: 12, flexShrink: 0,
          background: 'color-mix(in oklab, var(--reject) 10%, transparent)',
          border: '1px solid color-mix(in oklab, var(--reject) 30%, transparent)',
          borderRadius: 10, padding: 'var(--sp-3) var(--sp-4)',
        }}>
          <div className="flex aic" style={{ gap: 10, minWidth: 0 }}>
            <Icon name="info" size={16} style={{ color: 'var(--reject)', flexShrink: 0 }} />
            <span className="fs-xs" style={{ color: 'var(--reject)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{error}</span>
          </div>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss" style={{ background: 'none', border: 'none', padding: 4, cursor: 'pointer', color: 'var(--reject)', flexShrink: 0 }}>
            <Icon name="x" size={14} />
          </button>
        </div>
      )}

      {/* Body */}
      {status === 'loading' && (
        <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 'var(--pad)' }}>
          <div style={{ textAlign: 'center', color: 'var(--fg-3)' }}>
            <div style={{ animation: 'bbp-fade-in .5s infinite alternate' }}>
              <Icon name="image" size={44} stroke={1.2} style={{ color: 'var(--accent)' }} />
            </div>
            <p className="fs-sm" style={{ marginTop: 14 }}>Loading review queue…</p>
          </div>
        </div>
      )}

      {status === 'error' && (
        <EmptyState
          icon="aperture"
          title="Couldn't reach the server"
          body="The review queue needs the session API. Make sure Flask is running, then try again."
          onRefresh={() => load(true)}
          refreshing={false}
        />
      )}

      {status === 'no-run' && (
        <EmptyState
          icon="aperture"
          title="No active run"
          body="There's nothing to review right now — no session is running. Start a session, and every photo that clears its score threshold will land here for you to keep or reject."
          onRefresh={() => load(false)}
          refreshing={loadingPhotos}
        />
      )}

      {showEmpty && (
        <EmptyState
          icon="check"
          title="Nothing awaiting review"
          body="The queue is clear. New photos that score above your session's threshold will appear here as the run processes them — this can take a moment after a run starts. The page is watching, so you don't need to refresh."
          onRefresh={() => load(false)}
          refreshing={loadingPhotos}
        />
      )}

      {status === 'ready' && loadingPhotos && photos.length === 0 && (
        <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 'var(--pad)' }}>
          <p className="fs-sm" style={{ color: 'var(--fg-3)' }}>Fetching photos…</p>
        </div>
      )}

      {/* Thumbnail grid */}
      {status === 'ready' && photos.length > 0 && (
        <>
          <div style={{ padding: 'var(--pad)', flex: 1, minHeight: 0, overflowY: 'auto' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8 }}>
              {photos.map((photo) => (
                <Thumb
                  key={photo.id}
                  photo={photo}
                  active={currentPhoto?.id === photo.id}
                  onClick={() => setSelectedId(photo.id)}
                />
              ))}
            </div>
          </div>

          {/* Keep / Reject dock — large, thumb-reachable */}
          <div className="flex" style={{
            gap: 'var(--sp-3)', padding: 'var(--sp-3) var(--pad)',
            flexShrink: 0, background: 'var(--bg-2)',
            border: '1px solid var(--line)', borderRadius: 14,
          }}>
            <button
              type="button"
              onClick={() => handleDecision(currentPhoto, 'reject')}
              disabled={!currentPhoto}
              aria-label="Reject (R)"
              title="Reject (R)"
              style={{
                flex: 1, height: 60, borderRadius: 12,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                background: 'color-mix(in oklab, var(--reject) 14%, var(--bg-3))',
                border: '1px solid color-mix(in oklab, var(--reject) 40%, var(--line))',
                color: 'var(--reject)', cursor: 'pointer',
                transition: 'all .12s var(--ease-out)', fontWeight: 700,
                letterSpacing: '.04em', textTransform: 'uppercase', fontSize: 'var(--fs-sm)',
              }}
            >
              <Icon name="x" size={20} stroke={2.5} />
              Reject
              {!isMobile && <kbd style={{ fontFamily: 'var(--font-mono)', fontSize: 10, padding: '3px 6px', background: 'rgba(0,0,0,.18)', border: '1px solid color-mix(in oklab, var(--reject) 25%, transparent)', borderRadius: 4 }}>R</kbd>}
            </button>
            <button
              type="button"
              onClick={() => handleDecision(currentPhoto, 'keep')}
              disabled={!currentPhoto}
              aria-label="Keep (P)"
              title="Keep (P)"
              style={{
                flex: 1, height: 60, borderRadius: 12,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                background: 'color-mix(in oklab, var(--keep) 14%, var(--bg-3))',
                border: '1px solid color-mix(in oklab, var(--keep) 40%, var(--line))',
                color: 'var(--keep)', cursor: 'pointer',
                transition: 'all .12s var(--ease-out)', fontWeight: 700,
                letterSpacing: '.04em', textTransform: 'uppercase', fontSize: 'var(--fs-sm)',
              }}
            >
              <Icon name="check" size={20} stroke={2.5} />
              Keep
              {!isMobile && <kbd style={{ fontFamily: 'var(--font-mono)', fontSize: 10, padding: '3px 6px', background: 'rgba(0,0,0,.18)', border: '1px solid color-mix(in oklab, var(--keep) 25%, transparent)', borderRadius: 4 }}>P</kbd>}
            </button>
          </div>
        </>
      )}

      {/* Lightbox */}
      {status === 'ready' && currentPhoto && selectedId != null && (
        <div
          onClick={() => setSelectedId(null)}
          onKeyDown={(e) => { if (e.key === 'Escape') setSelectedId(null); }}
          role="dialog"
          aria-modal="true"
          aria-label={currentPhoto.filename || 'Photo detail'}
          tabIndex={-1}
          style={{
            position: 'fixed', inset: 0, zIndex: 100,
            background: 'rgba(0,0,0,.86)', backdropFilter: 'blur(6px)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            padding: 'var(--sp-5)', gap: 'var(--sp-4)',
          }}
        >
          <div className="flex aic jcsb" style={{ width: 'min(100%, 900px)', gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <span className="mono fs-xs" style={{ color: 'var(--fg-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
                {currentPhoto.filename || `photo ${currentPhoto.id}`}
              </span>
              <span className="meta" style={{ color: 'var(--fg-4)' }}>
                {photos.indexOf(currentPhoto) + 1} / {photos.length}
              </span>
            </div>
            <button type="button" onClick={() => setSelectedId(null)} aria-label="Close (Esc)" title="Close (Esc)" style={{
              width: 40, height: 40, borderRadius: 999, flexShrink: 0,
              background: 'rgba(255,255,255,.08)', border: '1px solid rgba(255,255,255,.14)',
              display: 'grid', placeItems: 'center', cursor: 'pointer', color: 'var(--fg)',
            }}>
              <Icon name="x" size={16} />
            </button>
          </div>

          <div role="presentation" style={{ position: 'relative', width: 'min(100%, 900px)', flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={(e) => e.stopPropagation()}>
            <img
              src={`/photos/${currentPhoto.id}/thumb`}
              alt={currentPhoto.filename || ''}
              style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 8, boxShadow: 'var(--shadow-2)' }}
            />
            {currentPhoto.overallScore != null && (
              <span style={{
                position: 'absolute', top: 12, right: 12, padding: '5px 10px', borderRadius: 999,
                background: 'rgba(0,0,0,.6)', border: '1px solid rgba(255,255,255,.1)',
                fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color: scoreColor(currentPhoto.overallScore),
              }}>
                {Math.round(currentPhoto.overallScore * 100)}/100
              </span>
            )}
          </div>

          <div className="flex" style={{ gap: 'var(--sp-3)', width: 'min(100%, 900px)' }}>
            <button type="button" onClick={() => advance(-1)} aria-label="Previous" style={{
              width: 56, height: 56, borderRadius: 999, flexShrink: 0,
              background: 'rgba(255,255,255,.08)', border: '1px solid rgba(255,255,255,.14)',
              display: 'grid', placeItems: 'center', cursor: 'pointer', color: 'var(--fg)',
            }}>
              <Icon name="arrowL" size={18} />
            </button>
            <button
              type="button"
              onClick={() => handleDecision(currentPhoto, 'reject')}
              aria-label="Reject (R)"
              title="Reject (R)"
              style={{
                flex: 1, height: 56, borderRadius: 12,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                background: 'rgba(255,255,255,.06)', border: '1px solid color-mix(in oklab, var(--reject) 45%, transparent)',
                color: 'var(--reject)', cursor: 'pointer', fontWeight: 700,
                letterSpacing: '.04em', textTransform: 'uppercase', fontSize: 'var(--fs-sm)',
              }}
            >
              <Icon name="x" size={20} stroke={2.5} /> Reject
            </button>
            <button
              type="button"
              onClick={() => handleDecision(currentPhoto, 'keep')}
              aria-label="Keep (P)"
              title="Keep (P)"
              style={{
                flex: 1, height: 56, borderRadius: 12,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                background: 'rgba(255,255,255,.06)', border: '1px solid color-mix(in oklab, var(--keep) 45%, transparent)',
                color: 'var(--keep)', cursor: 'pointer', fontWeight: 700,
                letterSpacing: '.04em', textTransform: 'uppercase', fontSize: 'var(--fs-sm)',
              }}
            >
              <Icon name="check" size={20} stroke={2.5} /> Keep
            </button>
            <button type="button" onClick={() => advance(1)} aria-label="Next" style={{
              width: 56, height: 56, borderRadius: 999, flexShrink: 0,
              background: 'rgba(255,255,255,.08)', border: '1px solid rgba(255,255,255,.14)',
              display: 'grid', placeItems: 'center', cursor: 'pointer', color: 'var(--fg)',
            }}>
              <Icon name="arrowR" size={18} />
            </button>
          </div>
        </div>
      )}

      {/* Approve-all confirm */}
      {confirmApprove && (
        <div
          role="presentation"
          onClick={() => setConfirmApprove(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 90,
            background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(4px)',
            display: 'grid', placeItems: 'center', padding: 'var(--sp-5)',
          }}
        >
          <div role="presentation" className="card" onClick={(e) => e.stopPropagation()} style={{ width: 'min(400px, 100%)', padding: 'var(--sp-6)', textAlign: 'center' }}>
            <div style={{
              width: 44, height: 44, borderRadius: 999, margin: '0 auto var(--sp-3)',
              display: 'grid', placeItems: 'center',
              background: 'color-mix(in oklab, var(--keep) 15%, var(--bg-3))', color: 'var(--keep)',
            }}>
              <Icon name="check" size={20} stroke={2} />
            </div>
            <div className="fs-md" style={{ fontWeight: 600 }}>
              Approve all {photos.length} photo{photos.length === 1 ? '' : 's'}?
            </div>
            <p className="fs-sm" style={{ color: 'var(--fg-3)', lineHeight: 1.55, margin: 'var(--sp-2) 0 var(--sp-5)' }}>
              Every photo in the queue moves straight to export. This clears the queue — there's no undo.
            </p>
            <div className="flex" style={{ gap: 8 }}>
              <button type="button" className="btn btn-ghost btn-uppercase" onClick={() => setConfirmApprove(false)} disabled={approving} style={{ flex: 1, height: 44 }}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary btn-uppercase" onClick={handleApproveAll} disabled={approving} style={{ flex: 1, height: 44 }}>
                {approving ? 'Approving…' : 'Approve all'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div role="status" aria-live="polite" style={{
          position: 'fixed', bottom: 92, left: '50%', transform: 'translateX(-50%)', zIndex: 120,
          padding: '10px 18px', borderRadius: 10,
          background: 'var(--bg-2)', border: '1px solid var(--line)', boxShadow: 'var(--shadow-2)',
          fontSize: 'var(--fs-xs)', color: 'var(--fg)',
          animation: 'bbp-fade-in .25s var(--ease-out)', pointerEvents: 'none', whiteSpace: 'nowrap',
        }}>
          <span style={{ width: 6, height: 6, borderRadius: 99, background: 'var(--accent)', boxShadow: '0 0 6px var(--accent)', display: 'inline-block', marginRight: 8, verticalAlign: 'middle' }} />
          {toast}
        </div>
      )}
    </div>
  );
}
