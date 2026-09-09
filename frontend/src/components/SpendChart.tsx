import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Spend } from "../types";
import { localX } from "./pointer";
import { clockLabel, usd } from "../format";

const PAD = { top: 10, right: 18, bottom: 22, left: 44 };

// Spend over time. Three things share one frame, and keeping them visually
// distinct is the entire point of this component:
//
//   1. ACTUAL, left of NOW  -- solid stacked areas, one per branch. This is the
//      attributable estimate (price integrated over time), so it decomposes.
//   2. GROUND TRUTH         -- a single line over the stack, realized burn from
//      Vast's own cumulative counter. It cannot be attributed to a branch, so it
//      cannot be part of the stack; divergence from the stack top is itself
//      informative.
//   3. REMAINDER, right of NOW -- a hatched WEDGE between the low and high
//      trailing burn. Drawn as a wedge rather than a line because the spread is
//      the honest content of the estimate: it says "depends whether these boxes
//      stay up" instead of asserting one confident number.
export function SpendChart({
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

  const now = spend.now;
  const trailing = spend.trailing_burn;
  // The forward extent is a quarter of the window, so the wedge is legible
  // without letting a speculative region dominate a chart of measured data.
  const forwardS = (windowMinutes * 60) / 4;
  const start = spend.start;
  const end = trailing.hi != null ? now + forwardS : spend.end;
  const span = Math.max(1, end - start);

  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;

  const branches = useMemo(() => Object.keys(spend.branch_series).sort(), [spend.branch_series]);

  // Union of bucket timestamps across branches, so the stack is well-defined
  // even when one branch started mid-window.
  //
  // Where NO branch has a bucket -- nothing was rented for a stretch -- two
  // synthetic zero stamps are inserted at the edges of the gap. Without them
  // the polygon runs straight from the last reading to the next one, drawing a
  // smooth ramp across hours when the fleet was empty and implying spend that
  // never happened. Dropping to zero and back is what actually occurred.
  const stamps = useMemo(() => {
    const set = new Set<number>();
    for (const b of branches) for (const p of spend.branch_series[b]) set.add(p.ts);
    const real = [...set].sort((a, b) => a - b);
    const bucket = spend.bucket_s || 60;
    const out: number[] = [];
    const synthetic = new Set<number>();
    for (let i = 0; i < real.length; i++) {
      if (i > 0 && real[i] - real[i - 1] > bucket * 2.5) {
        const lo = real[i - 1] + bucket * 0.5;
        const hi = real[i] - bucket * 0.5;
        out.push(lo, hi);
        synthetic.add(lo);
        synthetic.add(hi);
      }
      out.push(real[i]);
    }
    return { list: out, synthetic };
  }, [branches, spend.branch_series, spend.bucket_s]);

  const valueAt = useMemo(() => {
    const maps = new Map<string, Map<number, number>>();
    for (const b of branches) {
      maps.set(b, new Map(spend.branch_series[b].map((p) => [p.ts, p.dph_total ?? 0])));
    }
    return maps;
  }, [branches, spend.branch_series]);

  const stackTops = useMemo(
    () => stamps.list.map((ts) => branches.reduce((acc, b) => acc + (valueAt.get(b)!.get(ts) ?? 0), 0)),
    [stamps, branches, valueAt],
  );

  const yMax = useMemo(() => {
    const m = Math.max(
      ...stackTops,
      ...spend.account_burn.map((b) => b.burn_hr),
      trailing.hi ?? 0,
      0.001,
    );
    return m * 1.2;
  }, [stackTops, spend.account_burn, trailing.hi]);

  const x = (ts: number) => PAD.left + ((ts - start) / span) * plotW;
  const y = (v: number) => PAD.top + plotH - (Math.max(0, Math.min(yMax, v)) / yMax) * plotH;

  // Stacked areas, bottom band first.
  const bands = useMemo(() => {
    const list = stamps.list;
    let below = list.map(() => 0);
    return branches.map((b) => {
      const m = valueAt.get(b)!;
      const top = list.map((ts, i) => below[i] + (m.get(ts) ?? 0));
      const d =
        list.length < 2
          ? ""
          : `M${list.map((ts, i) => `${x(ts).toFixed(1)},${y(top[i]).toFixed(1)}`).join(" L")} ` +
            `L${[...list]
              .map((ts, i) => ({ ts, i }))
              .reverse()
              .map(({ ts, i }) => `${x(ts).toFixed(1)},${y(below[i]).toFixed(1)}`)
              .join(" L")} Z`;
      below = top;
      return { branch: b, d, color: colorFor(b) };
    });
  }, [branches, stamps, valueAt, yMax, plotW, plotH, width, start, span]);

  const burnLine = useMemo(() => {
    const pts = spend.account_burn.filter((p) => p.ts >= start);
    if (pts.length < 2) return "";
    return `M${pts.map((p) => `${x(p.ts).toFixed(1)},${y(p.burn_hr).toFixed(1)}`).join(" L")}`;
  }, [spend.account_burn, yMax, plotW, plotH, width, start, span]);

  const nowX = x(now);
  const wedge =
    trailing.lo != null && trailing.hi != null
      ? `M${nowX.toFixed(1)},${y(stackTops[stackTops.length - 1] ?? trailing.mean ?? 0).toFixed(1)} ` +
        `L${x(end).toFixed(1)},${y(trailing.hi).toFixed(1)} ` +
        `L${x(end).toFixed(1)},${y(trailing.lo).toFixed(1)} Z`
      : "";

  const ticks = useMemo(() => {
    const n = Math.max(2, Math.min(6, Math.floor(plotW / 100)));
    return Array.from({ length: n + 1 }, (_, i) => start + (span * i) / n);
  }, [start, span, plotW]);

  const hover = useMemo(() => {
    if (hoverX == null || !stamps.list.length) return null;
    const ts = start + ((hoverX - PAD.left) / plotW) * span;
    if (ts > now) return null;
    // Never snap to a synthetic gap marker: it is a drawing artefact, not a
    // reading, and reporting $0.00 at it would look like a measurement.
    let best: number | null = null;
    for (const s of stamps.list) {
      if (stamps.synthetic.has(s)) continue;
      if (best === null || Math.abs(s - ts) < Math.abs(best - ts)) best = s;
    }
    if (best === null) return null;
    const rows = branches
      .map((b) => ({ branch: b, v: valueAt.get(b)!.get(best!) ?? 0, color: colorFor(b) }))
      .filter((r) => r.v > 0);
    return { ts: best, rows, total: rows.reduce((a, r) => a + r.v, 0) };
  }, [hoverX, stamps, branches, valueAt, start, span, plotW, now]);

  return (
    <div className="tchart" ref={wrapRef}>
      <svg
        width={width}
        height={height}
        onPointerMove={(e) => setHoverX(localX(e, width))}
        onPointerLeave={() => setHoverX(null)}
      >
        <defs>
          {/* Hatching, not a fill: the projected region must never be mistaken
              for measured data at a glance. */}
          <pattern id="wedge-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="transparent" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="#8b949e" strokeWidth="1.6" opacity="0.55" />
          </pattern>
        </defs>

        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line
              x1={PAD.left}
              x2={PAD.left + plotW}
              y1={y(yMax * f)}
              y2={y(yMax * f)}
              stroke="#2a313c"
            />
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

        {wedge && <path d={wedge} fill="url(#wedge-hatch)" stroke="#8b949e" strokeWidth={1} strokeDasharray="4 3" />}

        {burnLine && (
          <path d={burnLine} fill="none" stroke="#e6edf3" strokeWidth={1.8} strokeLinejoin="round" />
        )}

        {/* The NOW rule: everything left is measured, everything right is not. */}
        <line x1={nowX} x2={nowX} y1={PAD.top} y2={PAD.top + plotH} stroke="#e6edf3" strokeWidth={1} />
        {/* Flip the label to the inside when the rule sits near the right edge,
            which it does whenever there is no projection to extend the frame. */}
        <text
          x={nowX + (nowX > PAD.left + plotW - 34 ? -4 : 4)}
          y={PAD.top + 9}
          textAnchor={nowX > PAD.left + plotW - 34 ? "end" : "start"}
          className="tchart-axis"
          fill="#e6edf3"
        >
          now
        </text>

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
              <span className="tchart-tip-val">{usd(r.v)}</span>
              <span className="tchart-tip-label">{r.branch}</span>
            </div>
          ))}
          <div className="tchart-tip-row tchart-tip-total">
            <span />
            <span className="tchart-tip-val">{usd(hover.total)}</span>
            <span className="tchart-tip-label">total /hr</span>
          </div>
        </div>
      )}

      {/* The stack is drawn in one colour per branch, so the key names them.
          A single swatch captioned "spend by branch" told the reader nothing
          about which colour was which. */}
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
        {trailing.hi != null && (
          <span className="key-item">
            <span className="key-swatch key-proj" /> projected range
          </span>
        )}
      </div>
    </div>
  );
}
