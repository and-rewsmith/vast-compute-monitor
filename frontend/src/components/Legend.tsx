// Legend for the multi-series charts. Present whenever there are >= 2 series so
// identity is never carried by color alone; the swatch is a short stroke because
// the marks it keys are lines.
export function Legend({
  items,
}: {
  items: { key: string; label: string; color: string; muted?: boolean }[];
}) {
  if (items.length < 2) return null;
  return (
    <div className="legend">
      {items.map((it) => (
        <span key={it.key} className={`legend-item${it.muted ? " legend-off" : ""}`}>
          <span className="legend-key" style={{ background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}
