import { useState, useEffect, useRef, useCallback } from 'react';
import { useStore } from '../store';
import Icon from '../components/Icon';
import ScoreBar from '../components/ScoreBar';
import DecisionBadge from '../components/DecisionBadge';

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
    <div style={{
      display: 'grid', gridTemplateColumns: '40px 1fr 1fr 1fr', gap: 'var(--sp-3)',
      padding: 'var(--sp-3)', background: 'var(--bg-2)',
      border: '1px solid var(--line)', borderRadius: 14, flexShrink: 0,
    }}>
      <button
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
                <span className="fs-sm" style={{ fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: isActive ? `var(--${kind})` : 'var(--fg)' }}>{label}</span>
                <span className="mono fs-xxs" style={{ color: 'var(--fg-3)' }}>{counts[kind]}</span>
              </span>
            </span>
            {showInlineKbd && (
              <kbd style={{ fontFamily: 'var(--font-mono)', fontSize: 10, padding: '3px 6px', background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 4, color: 'var(--fg-3)' }}>{kbd}</kbd>
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

  // Derive index from currentId; fall back to 0
  const idx = Math.max(0, order.indexOf(currentId));
  const photoId = order[idx] || order[0];
  const photo = photos[photoId];

  const goTo = useCallback((newIdx) => {
    const clamped = Math.max(0, Math.min(order.length - 1, newIdx));
    setCurrentId(order[clamped]);
  }, [order, setCurrentId]);

  const decide = useCallback((kind) => {
    if (!photoId) return;
    makeDecision(photoId, kind);
    setFlashKind(kind);
    setTimeout(() => setFlashKind(null), feedbackIntensity === 'pronounced' ? 320 : 180);
    setToast({ kind, label: { keep: 'Kept', maybe: 'Maybe', reject: 'Rejected' }[kind] });
    setTimeout(() => setToast(null), 1100);
    if (navigator.vibrate) navigator.vibrate(kind === 'reject' ? [12, 40, 12] : 18);
    setTimeout(() => goTo(idx + 1), 250);
  }, [photoId, idx, makeDecision, feedbackIntensity, goTo]);

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
    if (ax > T && ax > ay) decide(dx > 0 ? 'keep' : 'reject');
    else if (-dy > T && ay > ax) decide('maybe');
  }

  if (order.length === 0 || !photo) {
    return (
      <div className="view" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: 'var(--fg-3)' }}>
          <Icon name="image" size={48} stroke={1.2} />
          <p className="fs-sm" style={{ marginTop: 12 }}>No photos loaded. Go back and select a source folder.</p>
        </div>
      </div>
    );
  }

  // Score values (may be null before scoring completes)
  const sharp   = photo.sharpness            ?? null;
  const expo    = photo.exposure?.score      ?? null;
  const noise   = photo.noise?.score         ?? null;
  const comp    = photo.composition?.score   ?? null;
  const overall = photo.overallScore         ?? (sharp != null ? (sharp + (expo ?? 0) + (noise ?? 0) + (comp ?? 0)) / 4 : null);

  const hue = filenameHue(photo.filename || photo.id);
  const decision = photo.decision;
  const total = order.length;
  const decided = Object.values(photos).filter(p => p.decision != null).length;
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
    <div className="view culling-view" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Progress strip */}
      <div style={{ height: 2, background: 'var(--bg-3)', position: 'relative', flexShrink: 0 }}>
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${progress}%`, background: 'var(--accent)', boxShadow: '0 0 8px var(--accent)', transition: 'width .35s var(--ease-out)' }} />
      </div>

      <div className="culling-grid" style={{ flex: 1, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 'var(--gap)', padding: 'var(--pad)', minHeight: 0 }}>
        {/* Main column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)', minHeight: 0 }}>
          {/* Photo frame */}
          <div
            onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
            style={{
              position: 'relative', flex: 1, minHeight: 360,
              borderRadius: 14, overflow: 'hidden',
              background: 'var(--bg-2)',
              border: `1px solid ${flashKind ? `var(--${flashKind})` : 'var(--line)'}`,
              boxShadow: flashKind && feedbackIntensity === 'pronounced'
                ? `0 0 0 2px var(--${flashKind}), 0 0 32px color-mix(in oklab, var(--${flashKind}) 40%, transparent)`
                : 'none',
              transition: 'border-color .2s, box-shadow .2s',
              transform: swiping
                ? `translate(${swipeDx * 0.3}px, ${Math.min(0, swipeDy * 0.3)}px) rotate(${swipeDx * 0.02}deg)`
                : 'none',
              touchAction: 'none',
            }}
          >
            {/* Photo or art */}
            {photo.url ? (
              <img
                src={photo.url}
                alt={photo.filename || ''}
                style={{
                  position: 'absolute', inset: 0, width: '100%', height: '100%',
                  objectFit: 'contain', background: 'var(--bg-2)',
                  filter: flashKind ? 'brightness(1.08)' : 'none',
                  transition: 'filter .2s',
                }}
              />
            ) : (
              <PhotoArt hue={hue} flash={!!flashKind} />
            )}

            {/* Filename + burst badge */}
            <div style={{ position: 'absolute', top: 'var(--sp-4)', left: 'var(--sp-4)', display: 'flex', gap: 8, alignItems: 'center', padding: '6px 10px', borderRadius: 999, background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(8px)', border: '1px solid rgba(255,255,255,.08)' }}>
              <span className="mono fs-xxs" style={{ color: 'var(--fg)' }}>{photo.filename || photo.id}</span>
              <span style={{ color: 'var(--fg-4)' }}>&middot;</span>
              <span className="meta">{burstLabel}</span>
            </div>

            {/* Position counter */}
            <div style={{ position: 'absolute', top: 'var(--sp-4)', right: 'var(--sp-4)', padding: '6px 10px', borderRadius: 999, background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(8px)', border: '1px solid rgba(255,255,255,.08)' }} className="meta">
              <span className="mono" style={{ color: 'var(--fg)' }}>{String(idx + 1).padStart(2, '0')}</span>
              <span style={{ color: 'var(--fg-4)' }}> / </span>
              <span style={{ color: 'var(--fg-3)' }}>{String(total).padStart(2, '0')}</span>
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

          <DecisionDock counts={counts} decision={decision} decide={decide} undo={undo} canUndo={historyLen > 0} showInlineKbd={showInlineKbd} />

          <div className="meta ta-c" style={{ color: 'var(--fg-3)' }}>
            {decided > 0
              ? <>&middot; {counts.keep} kept &middot; {counts.maybe} maybe &middot; {counts.reject} rejected &middot;</>
              : <>&middot; Press P / M / R &middot; or swipe &middot;</>}
          </div>
        </div>

        {/* Sidebar */}
        <aside className="culling-side" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)', minWidth: 0 }}>
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

      <style>{`
        @media (max-width: 900px) {
          .culling-grid { grid-template-columns: 1fr !important; padding: 12px !important; }
          .culling-side { display: none !important; }
          .swipe-hint { display: inline-flex !important; }
        }
      `}</style>
    </div>
  );
}
