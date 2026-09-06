import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { clockLabel } from "../format";

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  points: { ts: number; v: number | null }[];
}

interface Props {
  series: ChartSeries[];
  start: number;
  end: number;
  windowMinutes: number;
  // Utilization charts pin to 0-100 so two charts side by side are comparable;
  // pass null to autoscale (used for throughput, whose range is unbounded).
  yMax: number | null;
  yFormat: (v: number) => string;
  height?: number;
  dimmed?: boolean;
}

const PAD = { top: 10, right: 54, bottom: 22, left: 40 };

// A gap longer than this many bucket widths is drawn as a break in the line
// rather than a straight interpolation across it. Without this, a poller that
// was down overnight draws a confident diagonal through hours it never sampled.
const GAP_BUCKETS = 2.5;

export function TimeChart({
  series,
  start,
  end,
  windowMinutes,
  yMax,
  yFormat,
  height = 190,
  dimmed = false,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hoverX, setHoverX] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const span = Math.max(1, end - start);
  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;

  const autoMax = useMemo(() => {
    if (yMax != null) return yMax;
    let m = 0;
    for (const s of series) for (const p of s.points) if (p.v != null && p.v > m) m = p.v;
    return m > 0 ? m * 1.15 : 1;
  }, [series, yMax]);

  const x = (ts: number) => PAD.left + ((ts - start) / span) * plotW;
  const y = (v: number) => PAD.top + plotH - (Math.max(0, Math.min(autoMax, v)) / autoMax) * plotH;

  // Median sample spacing drives the gap threshold, so the same code works for
  // a 15-minute window and a 7-day one without a magic time constant.
  const bucketS = useMemo(() => {
    const all = series.flatMap((s) => s.points.map((p) => p.ts)).sort((a, b) => a - b);
    if (all.length < 3) return span / 60;
    const deltas: number[] = [];
    for (let i = 1; i < all.length; i++) if (all[i] - all[i - 1] > 0) deltas.push(all[i] - all[i - 1]);
    if (!deltas.length) return span / 60;
    deltas.sort((a, b) => a - b);
    return deltas[Math.floor(deltas.length / 2)];
  }, [series, span]);

  // Split each series into unbroken runs: nulls (host did not report) and long
  // time gaps (poller was down) both start a new run.
  const paths = useMemo(() => {
    return series.map((s) => {
      const runs: string[] = [];
      let cur: string[] = [];
      let prevTs: number | null = null;
      const breakRun = () => {
        if (cur.length > 1) runs.push(cur.join(" "));
        cur = [];
      };
      for (const p of s.points) {
        // A null reading (host skipped its report) ends the current run.
        if (p.v == null) {
          breakRun();
          prevTs = p.ts;
          continue;
        }
        // So does a long time gap (poller was down).
        if (prevTs != null && p.ts - prevTs > bucketS * GAP_BUCKETS) breakRun();
        cur.push(`${cur.length ? "L" : "M"}${x(p.ts).toFixed(1)},${y(p.v).toFixed(1)}`);
        prevTs = p.ts;
      }
      if (cur.length > 1) runs.push(cur.join(" "));
      // A lone point would otherwise render as nothing; give it a 1px stub so a
      // single sample in the window is still visible.
      const singles = s.points.filter((p) => p.v != null).length === 1
        ? s.points.filter((p) => p.v != null).map((p) => `M${x(p.ts).toFixed(1)},${y(p.v!).toFixed(1)} l0.01,0`)
        : [];
      return { ...s, d: runs.concat(singles).join(" ") };
    });
  }, [series, bucketS, start, end, autoMax, plotW, plotH, width]);

  // Last known value per series, for the direct end-labels. Series whose latest
  // readings are close together would stack their labels on top of each other
  // (two instances both idling near 30% is the common case), so the labels are
  // nudged apart vertically after placement: sort by natural y, then walk down
  // enforcing a minimum gap. The nudge is cosmetic -- the line itself is never
  // moved, so a label may sit slightly off its line when crowded, which is the
  // right trade against an unreadable overlap.
  const LABEL_GAP = 11;
  const endLabels = useMemo(() => {
    const placed = series
      .map((s) => {
        for (let i = s.points.length - 1; i >= 0; i--) {
          if (s.points[i].v != null) {
            return { key: s.key, color: s.color, v: s.points[i].v!, y: y(s.points[i].v!) };
          }
        }
        return null;
      })
      .filter((v): v is { key: string; color: string; v: number; y: number } => v != null)
      .sort((a, b) => a.y - b.y);

    for (let i = 1; i < placed.length; i++) {
      if (placed[i].y - placed[i - 1].y < LABEL_GAP) placed[i].y = placed[i - 1].y + LABEL_GAP;
    }
    // If the pile ran past the bottom of the plot, push the whole stack back up.
    const overflow = placed.length ? placed[placed.length - 1].y - (PAD.top + plotH) : 0;
    if (overflow > 0) for (const p of placed) p.y -= overflow;
    return placed;
  }, [series, autoMax, plotH]);

  const ticks = useMemo(() => {
    const n = Math.max(2, Math.min(6, Math.floor(plotW / 90)));
    return Array.from({ length: n + 1 }, (_, i) => start + (span * i) / n);
  }, [start, span, plotW]);

  const yTicks = useMemo(() => {
    const n = 4;
    return Array.from({ length: n + 1 }, (_, i) => (autoMax * i) / n);
  }, [autoMax]);

  // Snap the crosshair to the nearest sampled timestamp so the reader aims at a
  // time, never at a 2px line.
  const hover = useMemo(() => {
    if (hoverX == null) return null;
    const ts = start + ((hoverX - PAD.left) / plotW) * span;
    let bestTs: number | null = null;
    let bestD = Infinity;
    for (const s of series)
      for (const p of s.points) {
        const d = Math.abs(p.ts - ts);
        if (d < bestD) {
          bestD = d;
          bestTs = p.ts;
        }
      }
    if (bestTs == null || bestD > bucketS * 3) return null;
    const rows = series.map((s) => {
      let best: { ts: number; v: number | null } | null = null;
      let bd = Infinity;
      for (const p of s.points) {
        const d = Math.abs(p.ts - bestTs!);
        if (d < bd) {
          bd = d;
          best = p;
        }
      }
      return { key: s.key, label: s.label, color: s.color, v: bd <= bucketS * 1.5 ? best?.v ?? null : null };
    });
    return { ts: bestTs, rows };
  }, [hoverX, series, start, span, plotW, bucketS]);

  useEffect(() => {
    if (!series.length) setHoverX(null);
  }, [series.length]);

  return (
    <div className="tchart" ref={wrapRef} style={{ opacity: dimmed ? 0.55 : 1 }}>
      <svg
        width={width}
        height={height}
        role="img"
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setHoverX(e.clientX - r.left);
        }}
        onPointerLeave={() => setHoverX(null)}
      >
        {yTicks.map((v, i) => (
          <g key={i}>
            <line
              x1={PAD.left}
              x2={PAD.left + plotW}
              y1={y(v)}
              y2={y(v)}
              stroke="#2a313c"
              strokeWidth={1}
            />
            <text x={PAD.left - 6} y={y(v) + 3.5} textAnchor="end" className="tchart-axis">
              {yFormat(v)}
            </text>
          </g>
        ))}
        {ticks.map((ts, i) => (
          <text key={i} x={x(ts)} y={height - 7} textAnchor="middle" className="tchart-axis">
            {clockLabel(ts, windowMinutes)}
          </text>
        ))}

        {paths.map((p) => (
          <path
            key={p.key}
            d={p.d}
            fill="none"
            stroke={p.color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {/* Direct end-labels: identity without having to consult the legend.
            Past four series they would crowd the gutter, and the legend plus the
            table view carry identity instead. */}
        {endLabels.length <= 4 &&
          endLabels.map((lv) => (
            <text
              key={lv.key}
              x={PAD.left + plotW + 6}
              y={lv.y + 3.5}
              className="tchart-endlabel"
              fill={lv.color}
            >
              {yFormat(lv.v)}
            </text>
          ))}

        {hover && (
          <>
            <line
              x1={x(hover.ts)}
              x2={x(hover.ts)}
              y1={PAD.top}
              y2={PAD.top + plotH}
              stroke="#8b949e"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            {hover.rows.map(
              (r) =>
                r.v != null && (
                  <circle
                    key={r.key}
                    cx={x(hover.ts)}
                    cy={y(r.v)}
                    r={3.5}
                    fill={r.color}
                    stroke="#161b22"
                    strokeWidth={2}
                  />
                ),
            )}
          </>
        )}
      </svg>

      {hover && (
        <div
          className="tchart-tip"
          style={{
            left: Math.min(Math.max(0, x(hover.ts) + 12), Math.max(0, width - 180)),
          }}
        >
          <div className="tchart-tip-ts">{clockLabel(hover.ts, windowMinutes)}</div>
          {hover.rows.map((r) => (
            <div key={r.key} className="tchart-tip-row">
              <span className="tchart-tip-key" style={{ background: r.color }} />
              <span className="tchart-tip-val">{r.v == null ? "—" : yFormat(r.v)}</span>
              <span className="tchart-tip-label">{r.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
