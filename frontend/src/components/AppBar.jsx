import Icon from './Icon';

export default function AppBar({ view, step, totalSteps, onHelp, projectName }) {
  const viewLabels = {
    landing: 'Landing',
    culling: 'Culling',
    compare: 'Compare',
    export: 'Review & Export',
  };
  return (
    <header className="appbar">
      <div className="brand">
        <span className="dot" />
        <span>BigBadPhotos</span>
      </div>
      <div className="crumbs" style={{ marginLeft: 8 }}>
        <span>v0.4</span>
        <span className="sep">/</span>
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
