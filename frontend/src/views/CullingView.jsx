import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useStore } from '../store';
import Icon from '../components/Icon';
import ScoreBar from '../components/ScoreBar';
import DecisionBadge from '../components/DecisionBadge';

/** 0–1 scores from /rank (nested objects use *_score keys). */
function photoMetrics01(p) {
  if (!p) return { sharp: null, expo: null, noise: null, comp: null };
  const sharp = p.sharpness ?? null;
  const e = p.exposure;
  const expo = e?.exposure_score ?? e?.score ?? null;
  const n = p.noise;
  const noise = n?.noise_score ?? n?.score ?? null;
  const c = p.composition;
  const comp = c?.composition_score ?? c?.score ?? null;
  return { sharp, expo, noise, comp };
}

/** `all` | `burst` (★ burst best) | `top20` (best 20% by AI rank). */
function buildFilteredOrder(order, photos, mode) {
  if (mode === 'all') return order;
  if (mode === 'burst') return order.filter((id) => photos[id]?.isBurstBest);
  if (mode === 'top20') {
    const scored = order.filter((id) => photos[id]?.rank != null);
    if (scored.length === 0) return order;
    const sorted = [...scored].sort((a, b) => photos[a].rank - photos[b].rank);
    const take = Math.max(1, Math.ceil(sorted.length * 0.2));
    const top = new Set(sorted.slice(0, take));
    return order.filter((id) => top.has(id));
  }
  return order;
}

function filenameHue(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xFFFF;
  return h % 360;
}

function PhotoArt({ hue, flash }) {
  return (
    <div style={{
      position: 'absolute', inset: 0,
      background: `
        radial-gradient(ellipse at 30% 20%, oklch(72% 0.15 ${hue}) 0%, transparent 55%),
        radial-gradient(ellipse at 70% 80%, oklch(35% 0.10 ${(hue + 40) % 360}) 0%, transparent 60%),
        linear-gradient(135deg, oklch(20% 0.04 ${hue}) 0%, oklch(12% 0.03 ${(hue + 180) % 360}) 100%)
      `,
      transition: 'filter .25s var(--ease-out)',
      filter: flash ? 'brightness(1.15) saturate(1.1)' : 'none',
    }}>
      <div style={{
        position: 'absolute', inset: 0,
        backgroundImage: 'repeating-linear-gradient(0deg, rgba(255,255,255,.015) 0 1px, transparent 1px 3px)',
        mixBlendMode: 'overlay',
      }} />
      <div style={{
        position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
        color: 'rgba(255,255,255,.4)',
      }}>
        <Icon name="image" size={40} stroke={1.2} />
        <span style={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}>RAW</span>
      </div>
    </div>
  );
}

function DecisionDock({ counts, decision, decide, undo, canUndo, showInlineKbd }) {
  const items = [
    { kind: 'reject', label: 'Reject', kbd: 'R', icon: 'x' },
    { kind: 'maybe',  label: 'Maybe',  kbd: 'M', icon: 'qmark' },
    { kind: 'keep',   label: 'Keep',   kbd: 'P', icon: 'check' },
  ];
  return (
    <div className="culling-dock">
      <button
        type="button"
        className="dock-btn"
        onClick={undo} disabled={!canUndo} aria-label="Undo" title="Undo (⌘Z)"
        style={{
          height: 56, borderRadius: 10, background: 'var(--bg-3)', border: '1px solid var(--line)',
          display: 'grid', placeItems: 'center',
          color: canUndo ? 'var(--fg-2)' : 'var(--fg-4)',
          cursor: canUndo ? 'pointer' : 'not-allowed', transition: 'all .15s',
        }}
      >
        <Icon name="undo" size={16} />
      </button>
      {items.map(({ kind, label, kbd, icon }) => {
        const isActive = decision === kind;
        return (
          <button
            key={kind}
            type="button"
            className="dock-btn"
            onClick={() => decide(kind)}
            style={{
              height: 56, borderRadius: 10, padding: '0 12px',
              background: isActive ? `color-mix(in oklab, var(--${kind}) 18%, var(--bg-3))` : 'var(--bg-3)',
              border: `1px solid ${isActive ? `var(--${kind})` : 'var(--line)'}`,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 8, cursor: 'pointer', transition: 'all .12s var(--ease-out)',
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                width: 28, height: 28, borderRadius: 99,
                background: `color-mix(in oklab, var(--${kind}) ${isActive ? 30 : 20}%, var(--bg-2))`,
                color: `var(--${kind})`, display: 'grid', placeItems: 'center', flexShrink: 0,
              }}>
                <Icon name={icon} size={14} stroke={2} />
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                <span className="fs-sm dock-label" style={{ fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: isActive ? `var(--${kind})` : 'var(--fg)' }}>{label}</span>
                <span className="mono fs-xxs dock-count" style={{ color: 'var(--fg-3)' }}>{counts[kind]}</span>
              </span>
            </span>
            {showInlineKbd && (
              <kbd className="dock-kbd" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, padding: '3px 6px', background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 4, color: 'var(--fg-3)' }}>{kbd}</kbd>
            )}
          </button>
        );
      })}
    </div>
  );
}

export default function CullingView({ feedbackIntensity = 'pronounced', showInlineKbd = true, onComplete }) {
  const photos       = useStore(state => state.photos);
  const order        = useStore(state => state.order);
  const currentId    = useStore(state => state.currentId);
  const setCurrentId = useStore(state => state.setCurrentId);
  const makeDecision = useStore(state => state.makeDecision);
  const undoAction   = useStore(state => state.undo);
  const historyLen   = useStore(state => state.history.length);

  const [flashKind, setFlashKind] = useState(null);
  const [toast, setToast] = useState(null);
  const [swipeDx, setSwipeDx] = useState(0);
  const [swipeDy, setSwipeDy] = useState(0);
  const [swiping, setSwiping] = useState(false);
  const [filterMode, setFilterMode] = useState('all');
  const [selection, setSelection] = useState(() => new Set());

  const activeOrder = useMemo(
    () => buildFilteredOrder(order, photos, filterMode),
    [order, photos, filterMode],
  );

  useEffect(() => {
    setSelection(new Set());
  }, [filterMode]);

  useEffect(() => {
    if (activeOrder.length === 0) return;
    if (!activeOrder.includes(currentId)) setCurrentId(activeOrder[0]);
  }, [activeOrder, currentId, setCurrentId]);

  const idx = Math.max(0, activeOrder.indexOf(currentId));
  const photoId = activeOrder[idx] || activeOrder[0];
  const photo = photos[photoId];

  const goTo = useCallback((newIdx) => {
    const len = activeOrder.length;
    if (len === 0) return;
    const clamped = Math.max(0, Math.min(len - 1, newIdx));
    setCurrentId(activeOrder[clamped]);
  }, [activeOrder, setCurrentId]);

  const toggleSelection = useCallback((id) => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAllInView = useCallback(() => {
    setSelection(new Set(activeOrder));
  }, [activeOrder]);

  const clearSelection = useCallback(() => {
    setSelection(new Set());
  }, []);

  const decide = useCallback((kind, opts = {}) => {
    const forceSingle = !!opts.forceSingle;
    const bulk = !forceSingle && selection.size > 0;
    const ids = bulk ? [...selection] : photoId ? [photoId] : [];
    if (ids.length === 0) return;
    ids.forEach((id) => makeDecision(id, kind));
    if (bulk) setSelection(new Set());
    setFlashKind(kind);
    setTimeout(() => setFlashKind(null), feedbackIntensity === 'pronounced' ? 320 : 180);
    const label = bulk
      ? `${ids.length} ${kind === 'keep' ? 'kept' : kind === 'maybe' ? 'maybe' : 'rejected'}`
      : { keep: 'Kept', maybe: 'Maybe', reject: 'Rejected' }[kind];
    setToast({ kind, label });
    setTimeout(() => setToast(null), 1100);
    if (navigator.vibrate) navigator.vibrate(kind === 'reject' ? [12, 40, 12] : 18);
    if (!bulk) {
      setTimeout(() => {
        const j = activeOrder.indexOf(photoId);
        if (j >= 0 && j < activeOrder.length - 1) setCurrentId(activeOrder[j + 1]);
      }, 250);
    }
  }, [selection, photoId, makeDecision, feedbackIntensity, activeOrder, setCurrentId]);

  const undo = useCallback(() => {
    const { history, order: ord } = useStore.getState();
    if (!history.length) return;
    const last = history[history.length - 1];
    undoAction();
    const i = ord.indexOf(last.id);
    if (i >= 0) setCurrentId(ord[i]);
    setToast({ kind: 'undo', label: 'Undone' });
    setTimeout(() => setToast(null), 900);
  }, [undoAction, setCurrentId]);

  useEffect(() => {
    function onKey(e) {
      if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return;
      const k = e.key.toLowerCase();
      if (k === 'p') { e.preventDefault(); decide('keep'); }
      else if (k === 'm') { e.preventDefault(); decide('maybe'); }
      else if (k === 'r') { e.preventDefault(); decide('reject'); }
      else if (k === 'arrowright') goTo(idx + 1);
      else if (k === 'arrowleft')  goTo(idx - 1);
      else if ((e.metaKey || e.ctrlKey) && k === 'z') { e.preventDefault(); undo(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [decide, undo, goTo, idx]);

  const touchRef = useRef({ x: 0, y: 0, active: false });
  function onTouchStart(e) {
    const t = e.touches[0];
    touchRef.current = { x: t.clientX, y: t.clientY, active: true };
    setSwiping(true);
  }
  function onTouchMove(e) {
    if (!touchRef.current.active) return;
    const t = e.touches[0];
    setSwipeDx(t.clientX - touchRef.current.x);
    setSwipeDy(t.clientY - touchRef.current.y);
  }
  function onTouchEnd() {
    const dx = swipeDx, dy = swipeDy;
    touchRef.current.active = false;
    setSwiping(false); setSwipeDx(0); setSwipeDy(0);
    const ax = Math.abs(dx), ay = Math.abs(dy), T = 80;
    if (ax > T && ax > ay) decide(dx > 0 ? 'keep' : 'reject', { forceSingle: true });
    else if (-dy > T && ay > ax) decide('maybe', { forceSingle: true });
  }

  if (order.length === 0) {
    return (
      <div className="view" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: 'var(--fg-3)' }}>
          <Icon name="image" size={48} stroke={1.2} />
          <p className="fs-sm" style={{ marginTop: 12 }}>No photos loaded. Go back and select a source folder.</p>
        </div>
      </div>
    );
  }

  if (activeOrder.length === 0) {
    return (
      <div className="view culling-view" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--pad)' }}>
        <div className="card" style={{ padding: 'var(--sp-6)', maxWidth: 420, textAlign: 'center' }}>
          <p className="fs-sm" style={{ color: 'var(--fg-2)', marginBottom: 'var(--sp-4)' }}>
            No photos match this AI filter (e.g. no burst “best” picks in this set).
          </p>
          <button type="button" className="btn btn-primary btn-uppercase" onClick={() => setFilterMode('all')}>
            Show all photos
          </button>
        </div>
      </div>
    );
  }

  if (!photo) {
    return null;
  }

  const { sharp, expo, noise, comp } = photoMetrics01(photo);
  const overall = photo.overallScore ?? (
    [sharp, expo, noise, comp].every((v) => v != null) ? (sharp + expo + noise + comp) / 4 : null
  );

  const hue = filenameHue(photo.filename || photo.id);
  const decision = photo.decision;
  const total = order.length;
  const activeTotal = activeOrder.length;
  const decided = Object.values(photos).filter(p => p.decision != null).length;
  const STRIP_MAX = 200;
  const stripOrder = activeOrder.length > STRIP_MAX ? activeOrder.slice(0, STRIP_MAX) : activeOrder;
  const progress = total > 0 ? (decided / total) * 100 : 0;
  const counts = {
    keep:   Object.values(photos).filter(p => p.decision === 'keep').length,
    maybe:  Object.values(photos).filter(p => p.decision === 'maybe').length,
    reject: Object.values(photos).filter(p => p.decision === 'reject').length,
  };

  const swipeKind = (() => {
    if (!swiping) return null;
    const ax = Math.abs(swipeDx), ay = Math.abs(swipeDy);
    if (ax > 30 && ax > ay) return swipeDx > 0 ? 'keep' : 'reject';
    if (-swipeDy > 30 && ay > ax) return 'maybe';
    return null;
  })();

  const burstLabel = photo.burstGroup != null
    ? `Burst ${photo.burstGroup}`
    : photo.isRaw ? 'RAW' : photo.filename?.split('.').pop()?.toUpperCase() || 'JPG';

  return (
    <div className="view culling-view">
      {/* Progress strip */}
      <div style={{ height: 2, background: 'var(--bg-3)', position: 'relative', flexShrink: 0 }}>
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${progress}%`, background: 'var(--accent)', boxShadow: '0 0 8px var(--accent)', transition: 'width .35s var(--ease-out)' }} />
      </div>

      <div className="culling-grid">
        {/* Main column */}
        <div className="culling-main">
              {/* Photo frame */}
              <div
            className="culling-viewer"
            onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
            style={{
              border: `1px solid ${flashKind ? `var(--${flashKind})` : 'var(--line)'}`,
              boxShadow: flashKind && feedbackIntensity === 'pronounced'
                ? `0 0 0 2px var(--${flashKind}), 0 0 32px color-mix(in oklab, var(--${flashKind}) 40%, transparent)`
                : 'none',
              transition: 'border-color .2s, box-shadow .2s',
              transform: swiping
                ? `translate(${swipeDx * 0.3}px, ${Math.min(0, swipeDy * 0.3)}px) rotate(${swipeDx * 0.02}deg)`
                : 'none',
            }}
          >
            {/* Photo or art */}
            {photo.url ? (
              <img
                key={photo.url}
                src={photo.url}
                alt={photo.filename || ''}
                style={{
                  filter: flashKind ? 'brightness(1.08)' : 'none',
                  transition: 'filter .2s',
                }}
              />
            ) : (
              <PhotoArt hue={hue} flash={!!flashKind} />
            )}

            {/* Filename + burst badge */}
            <div style={{ position: 'absolute', top: 'var(--sp-4)', left: 'var(--sp-4)', display: 'flex', gap: 8, alignItems: 'center', padding: '6px 10px', borderRadius: 999, background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(8px)', border: '1px solid rgba(255,255,255,.08)' }}>
              <span className="mono fs-xxs culling-filename" style={{ color: 'var(--fg)' }}>{photo.filename || photo.id}</span>
              <span style={{ color: 'var(--fg-4)' }}>&middot;</span>
              <span className="meta">{burstLabel}</span>
            </div>

            {/* Position counter */}
            <div style={{ position: 'absolute', top: 'var(--sp-4)', right: 'var(--sp-4)', padding: '6px 10px', borderRadius: 999, background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(8px)', border: '1px solid rgba(255,255,255,.08)' }} className="meta">
              <span className="mono" style={{ color: 'var(--fg)' }}>{String(idx + 1).padStart(2, '0')}</span>
              <span style={{ color: 'var(--fg-4)' }}> / </span>
              <span style={{ color: 'var(--fg-3)' }}>{String(activeTotal).padStart(2, '0')}</span>
              {filterMode !== 'all' && (
                <span style={{ display: 'block', marginTop: 4, fontSize: 10, color: 'var(--fg-4)' }}>{total} total</span>
              )}
            </div>

            {/* Burst best badge */}
            {photo.isBurstBest && (
              <div style={{ position: 'absolute', top: 'var(--sp-4)', left: '50%', transform: 'translateX(-50%)', padding: '4px 10px', borderRadius: 999, background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(8px)', border: '1px solid rgba(255,255,255,.08)' }} className="meta">
                <span style={{ color: 'var(--keep)' }}>★ Best</span>
              </div>
            )}

            {/* Decision badge */}
            {decision && (
              <div style={{ position: 'absolute', bottom: 'var(--sp-4)', left: 'var(--sp-4)' }}>
                <DecisionBadge kind={decision} />
              </div>
            )}

            {/* Swipe overlay */}
            {swipeKind && (
              <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none', background: `radial-gradient(ellipse at center, color-mix(in oklab, var(--${swipeKind}) 25%, transparent), transparent 60%)` }}>
                <div style={{ fontSize: 64, fontWeight: 800, color: `var(--${swipeKind})`, textShadow: '0 4px 20px rgba(0,0,0,.6)', letterSpacing: '-.04em', textTransform: 'uppercase' }}>{swipeKind}</div>
              </div>
            )}

            {/* Nav arrows */}
            <button onClick={() => goTo(idx - 1)} aria-label="Previous" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', width: 40, height: 40, borderRadius: 999, background: 'rgba(0,0,0,.5)', backdropFilter: 'blur(8px)', display: 'grid', placeItems: 'center', border: '1px solid rgba(255,255,255,.08)' }}>
              <Icon name="arrowL" size={16} />
            </button>
            <button onClick={() => goTo(idx + 1)} aria-label="Next" style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', width: 40, height: 40, borderRadius: 999, background: 'rgba(0,0,0,.5)', backdropFilter: 'blur(8px)', display: 'grid', placeItems: 'center', border: '1px solid rgba(255,255,255,.08)' }}>
              <Icon name="arrowR" size={16} />
            </button>

            {/* Swipe hint (mobile) */}
            {idx === 0 && !decision && (
              <div style={{ position: 'absolute', bottom: 'var(--sp-5)', left: '50%', transform: 'translateX(-50%)', display: 'none', alignItems: 'center', gap: 8, padding: '8px 14px', borderRadius: 999, background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(8px)', border: '1px solid rgba(255,255,255,.08)' }} className="swipe-hint">
                <Icon name="swipe" size={14} />
                <span className="meta">Swipe to decide</span>
              </div>
            )}
          </div>

          {/* Thumbnail strip: navigate + checkbox multi-select (Shift/Cmd/Ctrl+click also toggles) */}
          <div className="culling-strip">
            {stripOrder.map((id) => {
              const p = photos[id];
              const sel = selection.has(id);
              const cur = id === photoId;
              return (
                <div
                  key={id}
                  className="culling-strip-thumb"
                  style={{
                    position: 'relative', width: 64, height: 64, flexShrink: 0,
                    borderRadius: 8, overflow: 'hidden',
                    boxShadow: cur ? '0 0 0 2px var(--accent)' : sel ? '0 0 0 2px var(--keep)' : 'none',
                    border: '1px solid var(--line)',
                  }}
                >
                  <button
                    type="button"
                    onClick={(e) => {
                      if (e.shiftKey || e.metaKey || e.ctrlKey) {
                        e.preventDefault();
                        toggleSelection(id);
                      } else {
                        setCurrentId(id);
                      }
                    }}
                    aria-label={p?.filename || id}
                    aria-current={cur ? 'true' : undefined}
                    style={{
                      display: 'block', width: '100%', height: '100%', padding: 0, border: 'none', cursor: 'pointer',
                      background: 'var(--bg-3)',
                    }}
                  >
                    {p?.url ? (
                      <img key={p.url} src={p.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} draggable={false} />
                    ) : (
                      <div style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', color: 'var(--fg-4)' }}>
                        <Icon name="image" size={20} />
                      </div>
                    )}
                  </button>
                  <label
                    style={{
                      position: 'absolute', top: 4, left: 4, width: 18, height: 18, margin: 0,
                      display: 'grid', placeItems: 'center', cursor: 'pointer',
                      background: 'rgba(0,0,0,.55)', borderRadius: 4, border: '1px solid rgba(255,255,255,.2)',
                    }}
                    title="Select for bulk Keep / Maybe / Reject"
                  >
                    <input
                      type="checkbox"
                      checked={sel}
                      onChange={() => toggleSelection(id)}
                      style={{ width: 12, height: 12, margin: 0, cursor: 'pointer' }}
                    />
                  </label>
                </div>
              );
            })}
            {activeOrder.length > STRIP_MAX && (
              <span className="meta" style={{ alignSelf: 'center', paddingLeft: 8, flexShrink: 0 }}>
                +{activeOrder.length - STRIP_MAX} more (use Select all)
              </span>
            )}
          </div>

          {selection.size > 0 && (
            <div className="meta ta-c culling-selection-hint" style={{ color: 'var(--accent)' }}>
              {selection.size} selected &middot; P / M / R applies to all selected
            </div>
          )}

          <DecisionDock counts={counts} decision={decision} decide={decide} undo={undo} canUndo={historyLen > 0} showInlineKbd={showInlineKbd} />

          <div className="meta ta-c culling-session-meta" style={{ color: 'var(--fg-3)' }}>
            {decided > 0
              ? <>&middot; {counts.keep} kept &middot; {counts.maybe} maybe &middot; {counts.reject} rejected &middot;</>
              : <>&middot; Press P / M / R &middot; or swipe &middot;</>}
          </div>
        </div>

        {/* Sidebar */}
        <aside className="culling-side">
          <div className="card" style={{ padding: 'var(--sp-5)' }}>
            <div className="flex jcsb aic" style={{ marginBottom: 'var(--sp-4)' }}>
              <div>
                <div className="meta">Quality</div>
                <div className="fs-xl" style={{ fontWeight: 600, marginTop: 2, fontFamily: 'var(--font-mono)', letterSpacing: 'var(--tracking-tight)' }}>
                  {overall != null
                    ? <>{Math.round(overall * 100)}<span className="dim" style={{ fontSize: 14 }}>/100</span></>
                    : <span className="dim" style={{ fontSize: 14 }}>—</span>}
                </div>
              </div>
              {overall != null ? (
                <span className="dbadge" style={{ color: overall >= .75 ? 'var(--keep)' : overall >= .5 ? 'var(--warning)' : 'var(--reject)' }}>
                  <span className="glyph" />
                  {overall >= .75 ? 'Strong' : overall >= .5 ? 'Mixed' : 'Weak'}
                </span>
              ) : (
                <span className="dbadge" style={{ color: 'var(--fg-3)' }}>
                  <span className="glyph" />Unscored
                </span>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
              <ScoreBar value={sharp ?? 0}  label="Sharpness"   />
              <ScoreBar value={expo  ?? 0}  label="Exposure"    />
              <ScoreBar value={noise ?? 0}  label="Noise"       />
              <ScoreBar value={comp  ?? 0}  label="Composition" />
            </div>
            {overall == null && (
              <div className="fs-xxs dim mono upper" style={{ marginTop: 'var(--sp-3)', paddingTop: 'var(--sp-3)', borderTop: '1px dashed var(--line)' }}>
                {photo.isRaw ? 'RAW — not scoreable' : 'Awaiting backend score'}
              </div>
            )}
          </div>

          <div className="card" style={{ padding: 'var(--sp-5)' }}>
            <div className="meta" style={{ marginBottom: 'var(--sp-3)' }}>AI browse</div>
            <label className="fs-xxs dim mono upper" style={{ display: 'block', marginBottom: 6 }}>Filter</label>
            <select
              className="fs-sm"
              value={filterMode}
              onChange={(e) => setFilterMode(e.target.value)}
              style={{
                width: '100%', marginBottom: 'var(--sp-3)', padding: '10px 12px',
                borderRadius: 10, border: '1px solid var(--line)', background: 'var(--bg-3)', color: 'var(--fg)',
              }}
            >
              <option value="all">All photos</option>
              <option value="burst">★ Burst best (AI)</option>
              <option value="top20">Top 20% by AI rank</option>
            </select>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
              <button type="button" className="btn btn-ghost btn-uppercase" onClick={selectAllInView} style={{ height: 40, fontSize: 'var(--fs-xxs)' }}>
                Select all in view
              </button>
              <button type="button" className="btn btn-ghost btn-uppercase" onClick={clearSelection} disabled={selection.size === 0} style={{ height: 40, fontSize: 'var(--fs-xxs)' }}>
                Clear selection
              </button>
            </div>
            <div className="mono fs-xxs dim" style={{ marginTop: 'var(--sp-3)', color: 'var(--fg-3)' }}>
              {selection.size} selected &middot; strip checkboxes or Shift/Cmd/Ctrl+click thumb
            </div>
          </div>

          <div className="card" style={{ padding: 'var(--sp-5)' }}>
            <div className="meta" style={{ marginBottom: 'var(--sp-4)' }}>This Session</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
              {[{ k: 'keep', l: 'Keep', v: counts.keep }, { k: 'maybe', l: 'Maybe', v: counts.maybe }, { k: 'reject', l: 'Reject', v: counts.reject }].map(({ k, l, v }) => (
                <div key={k} className="flex jcsb aic">
                  <div className="flex aic gap-2">
                    <span style={{ width: 8, height: 8, borderRadius: 99, background: `var(--${k})`, boxShadow: `0 0 6px var(--${k})` }} />
                    <span className="fs-sm">{l}</span>
                  </div>
                  <span className="mono fs-md" style={{ fontWeight: 500 }}>{String(v).padStart(2, '0')}</span>
                </div>
              ))}
              <div style={{ height: 1, background: 'var(--line)' }} />
              <div className="flex jcsb aic">
                <span className="meta">Decided</span>
                <span className="mono fs-sm" style={{ color: 'var(--fg)' }}>{decided} / {total}</span>
              </div>
            </div>
          </div>

          {decided === total && total > 0 && (
            <button className="btn btn-primary btn-uppercase" onClick={onComplete} style={{ height: 48 }}>
              <span>Review export</span>
              <Icon name="arrowR" size={14} />
            </button>
          )}
        </aside>
      </div>

      {toast && (
        <div className="toast-host">
          <div className="toast">
            {toast.kind === 'undo'
              ? <><Icon name="undo" size={12} /><span>{toast.label}</span></>
              : <><span style={{ width: 6, height: 6, borderRadius: 99, background: `var(--${toast.kind})`, boxShadow: `0 0 6px var(--${toast.kind})` }} /><span>{toast.label}</span></>}
          </div>
        </div>
      )}

    </div>
  );
}
