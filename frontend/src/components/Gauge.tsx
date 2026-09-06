import { loadColor } from "../format";

interface Props {
  value: number | null; // 0..100
  label: string;
  sublabel?: string;
  size?: number;
  // When the reading is stale (the host skipped a report), the arc is drawn
  // faded so the number is visibly "last known", not "current".
  stale?: boolean;
  // Which colour scale the arc uses. Defaults to loadColor (high = pressure =
  // red); pass utilColor for rented-compute utilization, where high = good.
  colorFn?: (v: number | null | undefined) => string;
}

// Radial arc gauge (270 degree sweep) as inline SVG — no chart dependency.
// Kept deliberately identical to the dev-server dashboard's gauge so the two
// read as the same instrument.
export function Gauge({ value, label, sublabel, size = 120, stale = false, colorFn = loadColor }: Props) {
  const stroke = 10;
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const sweep = 270;
  const start = 135;
  const circ = 2 * Math.PI * r;
  const arcLen = circ * (sweep / 360);
  const pct = value == null ? 0 : Math.max(0, Math.min(100, value));

  const polar = (deg: number) => {
    const rad = (deg * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  };
  const [x0, y0] = polar(start);
  const [x1, y1] = polar(start + sweep);
  const trackPath = `M ${x0} ${y0} A ${r} ${r} 0 1 1 ${x1} ${y1}`;

  return (
    <div className="gauge">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <path d={trackPath} fill="none" stroke="#2a313c" strokeWidth={stroke} strokeLinecap="round" />
        <path
          d={trackPath}
          fill="none"
          stroke={colorFn(value)}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${arcLen} ${circ}`}
          strokeDashoffset={arcLen * (1 - pct / 100)}
          opacity={stale ? 0.4 : 1}
          style={{ transition: "stroke-dashoffset 0.4s ease, stroke 0.4s ease" }}
        />
        <text x={cx} y={cy - 2} textAnchor="middle" className="gauge-value">
          {value == null ? "—" : `${Math.round(value)}%`}
        </text>
        {sublabel && (
          <text x={cx} y={cy + 16} textAnchor="middle" className="gauge-sub">
            {sublabel}
          </text>
        )}
      </svg>
      <div className="gauge-label">{label}</div>
    </div>
  );
}
