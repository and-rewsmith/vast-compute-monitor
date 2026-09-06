export function bytes(n: number | null | undefined, digits = 1): string {
  if (n == null || Number.isNaN(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : digits)} ${units[i]}`;
}

export function rate(bps: number | null | undefined): string {
  if (bps == null) return "—";
  return `${bytes(bps, 1)}/s`;
}

export function gb(v: number | null | undefined, digits = 1): string {
  if (v == null || Number.isNaN(v)) return "—";
  if (v >= 1024) return `${(v / 1024).toFixed(digits)} TB`;
  return `${v.toFixed(v >= 100 ? 0 : digits)} GB`;
}

export function pct(v: number | null | undefined, digits = 0): string {
  if (v == null || Number.isNaN(v)) return "—";
  return `${v.toFixed(digits)}%`;
}

export function usd(v: number | null | undefined, digits = 3): string {
  if (v == null || Number.isNaN(v)) return "—";
  return `$${v.toFixed(digits)}`;
}

export function duration(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds)) return "—";
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// "12s ago" / "4m ago" — for freshness markers, where seconds matter.
export function ago(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function clockLabel(ts: number, windowMinutes: number): string {
  const d = new Date(ts * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  // Past a day the hour alone is ambiguous, so lead with the date.
  if (windowMinutes > 60 * 24) {
    return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
  }
  return `${hh}:${mm}`;
}

// Green → amber → red as a value approaches 100%.
export function loadColor(v: number | null | undefined): string {
  if (v == null) return "#3a4150";
  if (v < 50) return "#3fb950";
  if (v < 75) return "#d29922";
  if (v < 90) return "#db8a3a";
  return "#f85149";
}

// Utilization of RENTED compute reads the opposite way round to resource
// pressure. A GPU pinned at 99% is the outcome you are paying for; one sitting
// at 3% is money leaving the account for nothing. So compute utilization is
// green when high and red when low -- the inverse of loadColor, which stays
// correct for VRAM / RAM / disk, where "full" really is the thing to worry
// about. Getting this backwards would paint the healthiest box on the fleet in
// alarm red, so the two scales are deliberately separate functions.
export function utilColor(v: number | null | undefined): string {
  if (v == null) return "#3a4150";
  if (v >= 60) return "#3fb950";
  if (v >= 25) return "#d29922";
  return "#f85149";
}

export function tempColor(c: number | null | undefined): string {
  if (c == null) return "#3a4150";
  if (c < 60) return "#3fb950";
  if (c < 75) return "#d29922";
  if (c < 85) return "#db8a3a";
  return "#f85149";
}

// ---------------------------------------------------------------------------
// Categorical series palette — one fixed hue per instance, assigned in order
// and never cycled or re-assigned when the instance list changes.
//
// Validated with the dataviz skill's validate_palette.js against this app's
// panel surface (#161b22), dark mode:
//   chroma floor       PASS  (all >= 0.1)
//   CVD separation     PASS  (worst adjacent ΔE 18.3 deutan / 12.2 tritan)
//   normal-vision      PASS  (worst adjacent ΔE 19.4)
//   contrast vs panel  PASS  (all >= 3:1)
//   lightness band     deviates deliberately — the reference band (L 0.48-0.67)
//                      sits below GitHub-dark's chart ramps, and band-compliant
//                      colors measure ~2.6:1 on this surface, too dim to read at
//                      a glance. GitHub-dark is the design system this dashboard
//                      belongs to, so its ramps supply the lightness and the
//                      accessibility checks above are enforced unchanged.
//
// Identity is never carried by color alone: every chart ships a legend, direct
// end-labels, and a full table view of the same numbers.
export const SERIES_COLORS = [
  "#6095fa", // blue
  "#dab70d", // yellow
  "#ad74ff", // purple
  "#e77412", // orange
  "#21d1e1", // cyan
  "#1ab64d", // green
];

// A 7th+ instance would need a hue outside the validated set, so beyond the
// palette everything folds into one neutral "other" slot rather than inventing
// colors that have not been checked for CVD separation.
export const OVERFLOW_COLOR = "#8b949e";

export function seriesColor(orderIndex: number): string {
  return orderIndex < SERIES_COLORS.length ? SERIES_COLORS[orderIndex] : OVERFLOW_COLOR;
}
