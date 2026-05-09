export default function ScoreBar({ value, label }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="scorebar">
      <div className="flex jcsb aic" style={{ fontSize: 'var(--fs-xxs)' }}>
        <span className="meta">{label}</span>
        <span className="mono" style={{ color: 'var(--fg-2)' }}>{Math.round(pct)}</span>
      </div>
      <div className="scorebar-track">
        <div className="scorebar-fill" style={{ width: '100%' }} />
        <div className="scorebar-cap" style={{ width: `${100 - pct}%` }} />
      </div>
    </div>
  );
}
