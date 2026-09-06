// Compact filled sparkline for a single series inside an instance card. Nulls
// break the line (same rule as the big charts) so a host that stopped reporting
// leaves a visible gap instead of a straight line through missing time.
export function Sparkline({
  values,
  color,
  max,
  height = 34,
}: {
  values: (number | null)[];
  color: string;
  max: number | null;
  height?: number;
}) {
  const W = 100;
  const H = height;
  const real = values.filter((v): v is number => v != null);
  if (real.length < 2) {
    return <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" />;
  }
  const top = max ?? Math.max(...real, 1);
  const n = values.length;
  const px = (i: number) => (i / (n - 1)) * W;
  const py = (v: number) => H - (Math.max(0, Math.min(top, v)) / top) * (H - 2) - 1;

  const runs: { d: string; area: string }[] = [];
  let cur: string[] = [];
  let firstI = 0;
  const flush = (lastI: number) => {
    if (cur.length > 1) {
      runs.push({
        d: cur.join(" "),
        area: `M${px(firstI).toFixed(1)},${H} ` + cur.join(" ").replace(/^M/, "L") + ` L${px(lastI).toFixed(1)},${H} Z`,
      });
    }
    cur = [];
  };
  values.forEach((v, i) => {
    if (v == null) {
      flush(i - 1);
      return;
    }
    if (!cur.length) firstI = i;
    cur.push(`${cur.length ? "L" : "M"}${px(i).toFixed(1)},${py(v).toFixed(1)}`);
  });
  flush(n - 1);

  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {runs.map((r, i) => (
        <path key={`a${i}`} d={r.area} fill={color} fillOpacity={0.15} />
      ))}
      {runs.map((r, i) => (
        <path
          key={`l${i}`}
          d={r.d}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}
