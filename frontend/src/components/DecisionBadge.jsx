export default function DecisionBadge({ kind }) {
  const labels = { keep: 'Keep', maybe: 'Maybe', reject: 'Reject' };
  return (
    <span className={`dbadge ${kind}`}>
      <span className="glyph" />
      {labels[kind]}
    </span>
  );
}
