import { useState, useEffect, useRef, useCallback } from 'react';
import Icon from '../components/Icon';
import ScoreBar from '../components/ScoreBar';
import DecisionBadge from '../components/DecisionBadge';

const SAMPLE_PHOTOS = [
  { id: 'IMG_4421.ARW', burst: 'A', sharp: 0.92, expo: 0.78, noise: 0.88, comp: 0.71, hue: 28 },
  { id: 'IMG_4422.ARW', burst: 'A', sharp: 0.71, expo: 0.74, noise: 0.85, comp: 0.66, hue: 30 },
  { id: 'IMG_4423.ARW', burst: 'A', sharp: 0.45, expo: 0.62, noise: 0.81, comp: 0.58, hue: 32 },
  { id: 'IMG_4424.ARW', burst: 'B', sharp: 0.88, expo: 0.91, noise: 0.92, comp: 0.84, hue: 195 },
  { id: 'IMG_4425.ARW', burst: 'B', sharp: 0.65, expo: 0.83, noise: 0.79, comp: 0.72, hue: 200 },
  { id: 'IMG_4426.ARW', burst: 'C', sharp: 0.31, expo: 0.42, noise: 0.55, comp: 0.40, hue: 12 },
  { id: 'IMG_4427.ARW', burst: 'C', sharp: 0.58, expo: 0.66, noise: 0.71, comp: 0.62, hue: 14 },
  { id: 'IMG_4428.ARW', burst: 'D', sharp: 0.94, expo: 0.81, noise: 0.89, comp: 0.91, hue: 270 },
  { id: 'IMG_4429.ARW', burst: 'D', sharp: 0.52, expo: 0.58, noise: 0.66, comp: 0.55, hue: 268 },
  { id: 'IMG_4430.ARW', burst: 'E', sharp: 0.79, expo: 0.85, noise: 0.83, comp: 0.78, hue: 95 },
  { id: 'IMG_4431.ARW', burst: 'E', sharp: 0.82, expo: 0.79, noise: 0.81, comp: 0.80, hue: 92 },
  { id: 'IMG_4432.ARW', burst: 'F', sharp: 0.41, expo: 0.49, noise: 0.61, comp: 0.46, hue: 350 },
];

function PhotoArt({ photo, flash }) {
  const h = photo.hue;
  return (
    <div style={{
      position: 'absolute', inset: 0,
      background: `
        radial-gradient(ellipse at 30% 20%, oklch(72% 0.15 ${h}) 0%, transparent 55%),
        radial-gradient(ellipse at 70% 80%, oklch(35% 0.10 ${(h + 40) % 360}) 0%, transparent 60%),
        linear-gradient(135deg, oklch(20% 0.04 ${h}) 0%, oklch(12% 0.03 ${(h + 180) % 360}) 100%)
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
        position: 'absolute', left: '50%', top: '55%', transform: 'translate(-50%, -50%)',
        width: '34%', height: '50%',
        background: `radial-gradient(ellipse, oklch(60% 0.12 ${h}) 0%, transparent 70%)`,
        opacity: .7, filter: 'blur(1px)',
      }} />
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
          cursor: canUndo ? 'pointer' : 'not-allowed',
          transition: 'all .15s',
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

export default function CullingView({ feedbackIntensity = 'pronounced', showInlineKbd = true, onComplete, photos }) {
  const photoList = (photos && photos.length) ? photos : SAMPLE_PHOTOS;
  const [idx, setIdx] = useState(0);
  const [decisions, setDecisions] = useState({});
  const [history, setHistory] = useState([]);
  const [flashKind, setFlashKind] = useState(null);
  const [toast, setToast] = useState(null);
  const [swipeDx, setSwipeDx] = useState(0);
  const [swipeDy, setSwipeDy] = useState(0);
  const [swiping, setSwiping] = useState(false);
  const photo = photoList[idx];

  const counts = {
    keep:   Object.values(decisions).filter(d => d === 'keep').length,
    maybe:  Object.values(decisions).filter(d => d === 'maybe').length,
    reject: Object.values(decisions).filter(d => d === 'reject').length,
  };
  const decided = counts.keep + counts.maybe + counts.reject;
  const total = photoList.length;
  const progress = (decided / total) * 100;

  const decide = useCallback((kind) => {
    const prev = decisions[photo.id];
    setDecisions(d => ({ ...d, [photo.id]: kind }));
    setHistory(h => [...h, { id: photo.id, prev }]);
    setFlashKind(kind);
    setTimeout(() => setFlashKind(null), feedbackIntensity === 'pronounced' ? 320 : 180);
    setToast({ kind, label: { keep: 'Kept', maybe: 'Maybe', reject: 'Rejected' }[kind] });
    setTimeout(() => setToast(null), 1100);
    if (navigator.vibrate) navigator.vibrate(kind === 'reject' ? [12, 40, 12] : 18);
    setTimeout(() => setIdx(i => Math.min(i + 1, photoList.length - 1)), 250);
  }, [decisions, photo, feedbackIntensity, photoList.length]);

  const undo = useCallback(() => {
    if (!history.length) return;
    const last = history[history.length - 1];
    setHistory(h => h.slice(0, -1));
    setDecisions(d => {
      const next = { ...d };
      if (last.prev) next[last.id] = last.prev;
      else delete next[last.id];
      return next;
    });
    const i = photoList.findIndex(p => p.id === last.id);
    if (i >= 0) setIdx(i);
    setToast({ kind: 'undo', label: 'Undone' });
    setTimeout(() => setToast(null), 900);
  }, [history, photoList]);

  useEffect(() => {
    function onKey(e) {
      if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return;
      const k = e.key.toLowerCase();
      if (k === 'p') { e.preventDefault(); decide('keep'); }
      else if (k === 'm') { e.preventDefault(); decide('maybe'); }
      else if (k === 'r') { e.preventDefault(); decide('reject'); }
      else if (k === 'arrowright') setIdx(i => Math.min(i + 1, total - 1));
      else if (k === 'arrowleft')  setIdx(i => Math.max(i - 1, 0));
      else if ((e.metaKey || e.ctrlKey) && k === 'z') { e.preventDefault(); undo(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [decide, undo, total]);

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

  const overall = (photo.sharp + photo.expo + photo.noise + photo.comp) / 4;
  const decision = decisions[photo.id];

  const swipeKind = (() => {
    if (!swiping) return null;
    const ax = Math.abs(swipeDx), ay = Math.abs(swipeDy);
    if (ax > 30 && ax > ay) return swipeDx > 0 ? 'keep' : 'reject';
    if (-swipeDy > 30 && ay > ax) return 'maybe';
    return null;
  })();

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
            <PhotoArt photo={photo} flash={!!flashKind} />

            <div style={{ position: 'absolute', top: 'var(--sp-4)', left: 'var(--sp-4)', display: 'flex', gap: 8, alignItems: 'center', padding: '6px 10px', borderRadius: 999, background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(8px)', border: '1px solid rgba(255,255,255,.08)' }}>
              <span className="mono fs-xxs" style={{ color: 'var(--fg)' }}>{photo.id}</span>
              <span style={{ color: 'var(--fg-4)' }}>&middot;</span>
              <span className="meta">Burst {photo.burst}</span>
            </div>

            <div style={{ position: 'absolute', top: 'var(--sp-4)', right: 'var(--sp-4)', padding: '6px 10px', borderRadius: 999, background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(8px)', border: '1px solid rgba(255,255,255,.08)' }} className="meta">
              <span className="mono" style={{ color: 'var(--fg)' }}>{String(idx + 1).padStart(2, '0')}</span>
              <span style={{ color: 'var(--fg-4)' }}> / </span>
              <span style={{ color: 'var(--fg-3)' }}>{String(total).padStart(2, '0')}</span>
            </div>

            {decision && (
              <div style={{ position: 'absolute', bottom: 'var(--sp-4)', left: 'var(--sp-4)' }}>
                <DecisionBadge kind={decision} />
              </div>
            )}

            {swipeKind && (
              <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none', background: `radial-gradient(ellipse at center, color-mix(in oklab, var(--${swipeKind}) 25%, transparent), transparent 60%)` }}>
                <div style={{ fontSize: 64, fontWeight: 800, color: `var(--${swipeKind})`, textShadow: '0 4px 20px rgba(0,0,0,.6)', letterSpacing: '-.04em', textTransform: 'uppercase' }}>{swipeKind}</div>
              </div>
            )}

            <button onClick={() => setIdx(i => Math.max(0, i - 1))} aria-label="Previous" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', width: 40, height: 40, borderRadius: 999, background: 'rgba(0,0,0,.5)', backdropFilter: 'blur(8px)', display: 'grid', placeItems: 'center', border: '1px solid rgba(255,255,255,.08)' }}>
              <Icon name="arrowL" size={16} />
            </button>
            <button onClick={() => setIdx(i => Math.min(total - 1, i + 1))} aria-label="Next" style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', width: 40, height: 40, borderRadius: 999, background: 'rgba(0,0,0,.5)', backdropFilter: 'blur(8px)', display: 'grid', placeItems: 'center', border: '1px solid rgba(255,255,255,.08)' }}>
              <Icon name="arrowR" size={16} />
            </button>

            {idx === 0 && !decision && (
              <div style={{ position: 'absolute', bottom: 'var(--sp-5)', left: '50%', transform: 'translateX(-50%)', display: 'none', alignItems: 'center', gap: 8, padding: '8px 14px', borderRadius: 999, background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(8px)', border: '1px solid rgba(255,255,255,.08)' }} className="swipe-hint">
                <Icon name="swipe" size={14} />
                <span className="meta">Swipe to decide</span>
              </div>
            )}
          </div>

          <DecisionDock counts={counts} decision={decision} decide={decide} undo={undo} canUndo={history.length > 0} showInlineKbd={showInlineKbd} />

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
                  {Math.round(overall * 100)}<span className="dim" style={{ fontSize: 14 }}>/100</span>
                </div>
              </div>
              <span className="dbadge" style={{ color: overall >= .75 ? 'var(--keep)' : overall >= .5 ? 'var(--warning)' : 'var(--reject)' }}>
                <span className="glyph" />
                {overall >= .75 ? 'Strong' : overall >= .5 ? 'Mixed' : 'Weak'}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
              <ScoreBar value={photo.sharp} label="Sharpness" />
              <ScoreBar value={photo.expo}  label="Exposure" />
              <ScoreBar value={photo.noise} label="Noise" />
              <ScoreBar value={photo.comp}  label="Composition" />
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

          {decided === total && (
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
