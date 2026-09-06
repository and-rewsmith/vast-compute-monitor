import type { Snapshot, Spend } from "../types";
import { ago, duration, usd } from "../format";

const PERIOD_LABEL: Record<string, string> = {
  hour: "This hour",
  day: "Today",
  week: "This week",
};

// Coverage meter: how much of a period we actually observed. A "this week"
// figure assembled from four hours of data is a fragment, and it has to look
// like one rather than printing as a confident under-count.
function Coverage({ frac }: { frac: number }) {
  const p = Math.max(0, Math.min(100, frac * 100));
  return (
    <span className="cov" title={`${p.toFixed(1)}% of this period observed`}>
      <span className="cov-track">
        <span className="cov-fill" style={{ width: `${p}%` }} />
      </span>
      <span className="cov-num">{p < 1 ? "<1" : Math.round(p)}%</span>
    </span>
  );
}

export function Ledger({
  spend,
  snapshot,
  now,
}: {
  spend: Spend | null;
  snapshot: Snapshot;
  now: number;
}) {
  const trailing = spend?.trailing_burn;
  const dphNow = snapshot.fleet.dph_total;

  return (
    <div className="card ledger-card">
      <div className="card-head">
        <span className="card-title">Ledger</span>
        <span className="head-right muted small">
          {spend?.tracking_since
            ? `tracking since ${ago(now - spend.tracking_since)}`
            : "starting up…"}
        </span>
      </div>

      <div className="ledger-grid">
        <div className="ledger-head">
          <span />
          <span className="num">Actual</span>
          <span className="num">Remainder</span>
          <span className="num">Covered</span>
        </div>

        {(spend?.periods ?? []).map((p) => (
          <div key={p.key} className="ledger-row">
            <span className="ledger-label">
              {PERIOD_LABEL[p.key] ?? p.key}
              <span className="muted small"> · {duration(p.elapsed_s)} in</span>
            </span>
            <span className="num ledger-actual">{usd(p.actual, 2)}</span>
            <span className="num ledger-rem">
              {p.project && p.remainder_lo != null && p.remainder_hi != null ? (
                <span className="rem-range">
                  {usd(p.remainder_lo, 2)} – {usd(p.remainder_hi, 2)}
                </span>
              ) : (
                <span className="muted">—</span>
              )}
            </span>
            <span className="num">
              <Coverage frac={p.coverage} />
            </span>
          </div>
        ))}

        {/* Why a row is blank, said once, where the blank is. */}
        {(spend?.periods ?? []).some((p) => !p.project) && (
          <div className="ledger-note muted small">
            {trailing && trailing.lo == null
              ? `No remainder estimate yet — needs a few more spend samples (have ${trailing.samples}).`
              : "No remainder shown beyond a day: a week projected from hours of history would be a guess wearing a measurement's clothes."}
          </div>
        )}
      </div>

      <div className="ledger-foot">
        <div className="stat">
          <div className="stat-label">Burn now</div>
          <div className="stat-value">{usd(dphNow)}/hr</div>
          <div className="muted small">sum of prices</div>
        </div>
        <div className="stat">
          <div className="stat-label">Realized</div>
          <div className="stat-value">
            {trailing?.mean != null ? `${usd(trailing.mean)}/hr` : "—"}
          </div>
          <div className="muted small">
            {trailing?.lo != null && trailing?.hi != null
              ? `${usd(trailing.lo)}–${usd(trailing.hi)} trailing ${Math.round((trailing.window_s ?? 0) / 3600)}h`
              : "measuring…"}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Idle spend</div>
          <div
            className="stat-value"
            style={{ color: snapshot.fleet.idle_dph > 0 ? "#f85149" : undefined }}
          >
            {usd(snapshot.fleet.idle_dph)}/hr
          </div>
          <div className="muted small">GPUs under 5%</div>
        </div>
      </div>
    </div>
  );
}
