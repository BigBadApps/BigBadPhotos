import Icon from './Icon'

export default function CheckRow({ check }) {
  return (
    <div style={{ padding: 'var(--sp-4)', borderTop: '1px solid var(--line)' }}>
      <div className="flex jcsb aic">
        <span className="fs-sm" style={{ fontWeight: 600 }}>{check.check}</span>
        {check.ok ? (
          <span className="fs-xs mono upper" style={{ color: 'var(--keep)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icon name="check" size={14} /> OK
          </span>
        ) : (
          <span className="fs-xs mono upper" style={{ color: 'var(--reject)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icon name="x" size={14} /> Failed
          </span>
        )}
      </div>
      {check.detail && (
        <p className="fs-xs" style={{ color: 'var(--fg-2)', margin: '6px 0 0' }}>{check.detail}</p>
      )}
      {!check.ok && check.fix && (
        <div style={{
          marginTop: 'var(--sp-2)',
          background: 'color-mix(in oklab, var(--warning) 12%, transparent)',
          border: '1px solid color-mix(in oklab, var(--warning) 35%, var(--line))',
          borderRadius: 8,
          padding: 'var(--sp-3)',
          display: 'flex',
          gap: 10,
          alignItems: 'flex-start',
        }}>
          <Icon name="info" size={16} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: 1 }} />
          <div>
            <div className="fs-xxs mono upper" style={{ color: 'var(--warning)' }}>Fix</div>
            <p className="fs-sm" style={{ color: 'var(--fg)', margin: '4px 0 0', lineHeight: 1.5 }}>{check.fix}</p>
          </div>
        </div>
      )}
    </div>
  )
}
