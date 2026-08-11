import Icon from './Icon';

export default function AppBar({ view, step, totalSteps, onHelp, projectName }) {
  const viewLabels = {
    landing: 'Landing',
    culling: 'Culling',
    compare: 'Compare',
    edit: 'AI Edit',
    export: 'Review & Export',
  };
  return (
    <header className="appbar">
      <div className="brand" style={{ gap: 8 }}>
        <svg width="22" height="22" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
          <rect width="28" height="28" rx="6" fill="#1A1A1A"/>
          <g transform="translate(14,14)">
            <polygon points="-1.5,-3 2,-3 5,-11 -4,-11" fill="white" opacity="0.92"/>
            <polygon points="-1.5,-3 2,-3 5,-11 -4,-11" fill="white" opacity="0.92" transform="rotate(60)"/>
            <polygon points="-1.5,-3 2,-3 5,-11 -4,-11" fill="white" opacity="0.92" transform="rotate(120)"/>
            <polygon points="-1.5,-3 2,-3 5,-11 -4,-11" fill="white" opacity="0.92" transform="rotate(180)"/>
            <polygon points="-1.5,-3 2,-3 5,-11 -4,-11" fill="white" opacity="0.92" transform="rotate(240)"/>
            <polygon points="-1.5,-3 2,-3 5,-11 -4,-11" fill="white" opacity="0.92" transform="rotate(300)"/>
            <circle cx="0" cy="0" r="3.5" fill="#1A1A1A"/>
          </g>
        </svg>
        <span style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: 14, letterSpacing: '-0.01em', textTransform: 'none' }}>BigBadPhotos</span>
        <span style={{
          padding: '2px 7px', borderRadius: 999,
          background: 'var(--accent-soft)',
          border: '1px solid color-mix(in oklab, var(--accent) 35%, transparent)',
          fontFamily: 'var(--font-mono)', fontSize: 9,
          letterSpacing: '0.1em', textTransform: 'uppercase',
          color: 'var(--accent)', fontWeight: 500,
        }}>v2</span>
      </div>
      <div className="crumbs" style={{ marginLeft: 8 }}>
        <span className="active">{viewLabels[view] || view}</span>
      </div>
      <div className="spacer" />
      {projectName && (
        <div className="crumbs">
          <Icon name="folderOpen" size={14} />
          <span style={{ color: 'var(--fg-2)' }}>{projectName}</span>
        </div>
      )}
      {step != null && (
        <div className="step" title={`Workflow step ${step} of ${totalSteps}: ${viewLabels[view] || view}`}>
          <span>{String(step).padStart(2, '0')}/{String(totalSteps).padStart(2, '0')}</span>
          <span style={{ display: 'inline-flex', gap: 4, marginLeft: 4 }}>
            {Array.from({ length: totalSteps }).map((_, i) => (
              <span
                key={i}
                className={`pip${i + 1 < step ? ' done' : ''}${i + 1 === step ? ' active' : ''}`}
              />
            ))}
          </span>
        </div>
      )}
      <button className="iconbtn" onClick={onHelp} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">
        <Icon name="keyboard" size={16} />
      </button>
    </header>
  );
}
