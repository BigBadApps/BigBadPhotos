import Icon from './Icon';

export default function HelpOverlay({ open, onClose }) {
  if (!open) return null;

  const groups = [
    { title: 'Decisions',  items: [['P', 'Keep'], ['M', 'Maybe'], ['R', 'Reject']] },
    { title: 'Navigation', items: [['→', 'Next photo'], ['←', 'Previous photo'], ['Esc', 'Back / cancel']] },
    { title: 'Actions',    items: [['⌘Z', 'Undo last'], ['⌘⇧Z', 'Redo'], ['?', 'This menu'], ['/', 'Search']] },
    { title: 'View',       items: [['1', 'Sessions'], ['2', 'Culling'], ['3', 'Compare'], ['4', 'Export']] },
  ];

  return (
    <div
      role="dialog" aria-modal="true" onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 60,
        background: 'color-mix(in oklab, var(--bg) 70%, transparent)',
        backdropFilter: 'blur(8px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 'var(--sp-6)',
      }}
    >
      <div onClick={e => e.stopPropagation()} className="card card-elevated" style={{ maxWidth: 540, width: '100%' }}>
        <div className="flex jcsb aic" style={{ marginBottom: 'var(--sp-5)' }}>
          <div>
            <div className="meta">Reference</div>
            <div className="fs-lg" style={{ marginTop: 4, fontWeight: 600 }}>Keyboard Shortcuts</div>
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 'var(--sp-5)' }}>
          {groups.map(g => (
            <div key={g.title}>
              <div className="meta" style={{ marginBottom: 8 }}>{g.title}</div>
              <div className="flex col gap-2">
                {g.items.map(([k, l]) => (
                  <div key={k} className="flex jcsb aic fs-sm">
                    <span style={{ color: 'var(--fg-2)' }}>{l}</span>
                    <kbd className="mono" style={{ background: 'var(--bg-4)', border: '1px solid var(--line)', padding: '2px 8px', borderRadius: 4, fontSize: 11 }}>{k}</kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
