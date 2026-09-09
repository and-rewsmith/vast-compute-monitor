import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Spend } from "../types";
import { localX } from "./pointer";
import { clockLabel, usd } from "../format";

const PAD = { top: 10, right: 16, bottom: 22, left: 52 };

// Cumulative dollars across the selected window: "what has this cost me so far".
// Stacked by branch from the integrated per-branch price, with the amount Vast
// has actually charged drawn over it as a single line.
//
// Scoped to the WINDOW, never to a clock period. The earlier ledger reported
// "this hour" against a store that had only been running a few minutes, which
// produced an arithmetically correct number under a label that implied a full
// hour of coverage -- the number looked far too small for three instances.
// Here the axis states the period, so the total cannot be misread.
export function CumulativeSpend({
  spend,
  colorFor,
  windowMinutes,
  height = 200,
}: {
  spend: Spend;
  colorFor: (branch: string) => string;
  windowMinutes: number;
  height?: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hoverX, setHoverX] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const start = spend.start;
  const end = Math.max(spend.end, spend.now);
  const span = Math.max(1, end - start);
  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;

  const branches = useMemo(() => Object.keys(spend.branch_series).sort(), [spend.branch_series]);

  const stamps = useMemo(() => {
    const set = new Set<number>();
    for (const b of branches) for (const p of spend.branch_series[b]) set.add(p.ts);
    return [...set].sort((a, b) => a - b);
  }, [branches, spend.branch_series]);

  // Running sum of the per-bucket cost the SERVER integrated. Deliberately not
  // rate x bucket-spacing computed here: the client only has bucket midpoints,
  // so across a gap where a branch was not running that inference is wildly
  // wrong. A branch idle for 601 minutes and resuming at $2.681/hr had ~$26.89
  // of spend invented for hours it did not exist, pushing the total far above
  // what Vast actually charged. The server caps the interval per sample, so the
  // curve here agrees with the branch rail and with the ledger by construction.
  const cumulative = useMemo(() => {
    const cost = new Map<string, Map<number, number>>();
    for (const b of branches) {
      cost.set(b, new Map(spend.branch_series[b].map((p) => [p.ts, p.cost ?? 0])));
    }
    const out = new Map<string, number[]>();
    for (const b of branches) {
      const totals: number[] = [];
      let acc = 0;
      for (const ts of stamps) {
        acc += cost.get(b)!.get(ts) ?? 0;
        totals.push(acc);
      }
      out.set(b, totals);
    }
    return out;
  }, [branches, stamps, spend.branch_series]);

  // The burn series is resampled onto a 300s baseline, so its last point can
  // trail the window total by a few minutes. Close the line at `now` with the
  // un-resampled total, so the line ends exactly where the card header says it
  // does -- same measurement, just without the resampling lag.
  const truth = useMemo(() => {
    const pts = spend.account_burn
      .filter((p) => p.ts >= start && p.cum != null)
      .map((p) => ({ ts: p.ts, cum: p.cum as number }));
    if (pts.length && spend.window_spent >= pts[pts.length - 1].cum) {
      pts.push({ ts: spend.now, cum: spend.window_spent });
    }
    return pts;
  }, [spend.account_burn, spend.window_spent, spend.now, start]);

  const yMax = useMemo(() => {
    let top = 0;
    for (let i = 0; i < stamps.length; i++) {
      let s = 0;
      for (const b of branches) s += cumulative.get(b)![i];
      if (s > top) top = s;
    }
    for (const p of truth) if (p.cum > top) top = p.cum;
    return Math.max(top * 1.15, 0.01);
  }, [stamps, branches, cumulative, truth]);

  const x = (ts: number) => PAD.left + ((ts - start) / span) * plotW;
  const y = (v: number) => PAD.top + plotH - (Math.max(0, Math.min(yMax, v)) / yMax) * plotH;

  const bands = useMemo(() => {
    let below = stamps.map(() => 0);
    return branches.map((b) => {
      const totals = cumulative.get(b)!;
      const top = stamps.map((_, i) => below[i] + totals[i]);
      const d =
        stamps.length < 2
          ? ""
          : `M${stamps.map((ts, i) => `${x(ts).toFixed(1)},${y(top[i]).toFixed(1)}`).join(" L")} ` +
            `L${stamps
              .map((ts, i) => ({ ts, i }))
              .reverse()
              .map(({ ts, i }) => `${x(ts).toFixed(1)},${y(below[i]).toFixed(1)}`)
              .join(" L")} Z`;
      below = top;
      return { branch: b, d, color: colorFor(b), total: top[top.length - 1] ?? 0 };
    });
  }, [branches, stamps, cumulative, yMax, plotW, plotH, width, start, span]);

  const truthLine = useMemo(() => {
    if (truth.length < 2) return "";
    return `M${truth.map((p) => `${x(p.ts).toFixed(1)},${y(p.cum).toFixed(1)}`).join(" L")}`;
  }, [truth, yMax, plotW, plotH, width, start, span]);

  const ticks = useMemo(() => {
    const n = Math.max(2, Math.min(5, Math.floor(plotW / 110)));
    return Array.from({ length: n + 1 }, (_, i) => start + (span * i) / n);
  }, [start, span, plotW]);

  const hover = useMemo(() => {
    if (hoverX == null || !stamps.length) return null;
    const ts = start + ((hoverX - PAD.left) / plotW) * span;
    let bi = 0;
    for (let i = 0; i < stamps.length; i++) {
      if (Math.abs(stamps[i] - ts) < Math.abs(stamps[bi] - ts)) bi = i;
    }
    const rows = branches
      .map((b) => ({ branch: b, v: cumulative.get(b)![bi], color: colorFor(b) }))
      .filter((r) => r.v > 0);
    return { ts: stamps[bi], rows, total: rows.reduce((a, r) => a + r.v, 0) };
  }, [hoverX, stamps, branches, cumulative, start, span, plotW]);

  return (
    <div className="tchart" ref={wrapRef}>
      <svg
        width={width}
        height={height}
        onPointerMove={(e) => setHoverX(localX(e, width))}
        onPointerLeave={() => setHoverX(null)}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={PAD.left} x2={PAD.left + plotW} y1={y(yMax * f)} y2={y(yMax * f)} stroke="#2a313c" />
            <text x={PAD.left - 6} y={y(yMax * f) + 3.5} textAnchor="end" className="tchart-axis">
              {usd(yMax * f, 2)}
            </text>
          </g>
        ))}
        {ticks.map((ts, i) => (
          <text key={i} x={x(ts)} y={height - 7} textAnchor="middle" className="tchart-axis">
            {clockLabel(ts, windowMinutes)}
          </text>
        ))}

        {bands.map((b) => (
          <path key={b.branch} d={b.d} fill={b.color} fillOpacity={0.5} stroke={b.color} strokeWidth={1} />
        ))}
        {truthLine && <path d={truthLine} fill="none" stroke="#e6edf3" strokeWidth={1.8} strokeLinejoin="round" />}

        {hover && (
          <line
            x1={x(hover.ts)}
            x2={x(hover.ts)}
            y1={PAD.top}
            y2={PAD.top + plotH}
            stroke="#8b949e"
            strokeDasharray="3 3"
          />
        )}
      </svg>

      {hover && (
        <div className="tchart-tip" style={{ left: Math.min(Math.max(0, x(hover.ts) + 12), Math.max(0, width - 200)) }}>
          <div className="tchart-tip-ts">{clockLabel(hover.ts, windowMinutes)}</div>
          {hover.rows.map((r) => (
            <div key={r.branch} className="tchart-tip-row">
              <span className="tchart-tip-key" style={{ background: r.color }} />
              <span className="tchart-tip-val">{usd(r.v, 2)}</span>
              <span className="tchart-tip-label">{r.branch}</span>
            </div>
          ))}
          <div className="tchart-tip-row tchart-tip-total">
            <span />
            <span className="tchart-tip-val">{usd(hover.total, 2)}</span>
            <span className="tchart-tip-label">total so far</span>
          </div>
        </div>
      )}

      <div className="spend-key muted small">
        {branches.map((b) => (
          <span key={b} className="key-item">
            <span className="key-swatch" style={{ background: colorFor(b), opacity: 0.75 }} />
            {b}
          </span>
        ))}
        <span className="key-item">
          <span className="key-swatch key-truth" /> total Vast charged
        </span>
      </div>
    </div>
  );
}
