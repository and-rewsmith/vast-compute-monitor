import type { Branch, BranchCost } from "../types";
import { ago, duration, pct, usd, utilColor } from "../format";

// Samples recorded before branch tracking existed carry no label. They are real
// measurements and their cost is real, but they are NOT a branch that ran and
// finished -- so the band says what they actually are rather than inventing a
// lifecycle for them.
const UNLABELED = "(unlabeled)";

// The branch band: the label rendered as the headline, because instances are
// labelled with the branch they are running and several workers share one. The
// branch is therefore the unit of work, of display, and of cost attribution --
// the instance id is an implementation detail below it.
function Band({
  name,
  color,
  live,
  cost,
  now,
}: {
  name: string;
  color: string;
  live: Branch | null;
  cost: BranchCost | null;
  now: number;
}) {
  const active = live != null;
  const unlabeled = name === UNLABELED;
  const util = live?.gpu_util ?? cost?.avg_gpu_util ?? null;
  const ranFor = cost ? cost.last_seen - cost.first_seen : null;
  const endedAgo = cost && !active ? now - cost.last_seen : null;

  return (
    <div
      className={`branch-band${active ? "" : " branch-done"}${unlabeled ? " branch-unlabeled" : ""}`}
      style={{ borderLeftColor: color }}
    >
      <div className="branch-top">
        <span className="branch-name" title={name}>
          {name}
        </span>
        <span className={`pill ${active ? "ok" : "off"}`}>
          {unlabeled
            ? "no branch recorded"
            : active
              ? "active"
              : endedAgo != null
                ? `finished ${ago(endedAgo)}`
                : "finished"}
        </span>
        <span className="branch-facts muted small">
          {unlabeled
            ? `${cost?.instances ?? 0} inst · samples taken before branch tracking`
            : active
              ? `${live!.running}/${live!.instances} inst · ${live!.gpus} GPUs · ${usd(live!.dph_total)}/hr`
              : `${cost?.instances ?? 0} inst · ran ${duration(ranFor)}`}
        </span>
      </div>

      <div className="branch-body">
        <div className="branch-util">
          <div className="branch-util-track">
            <div
              className="branch-util-fill"
              style={{
                width: `${Math.max(0, Math.min(100, util ?? 0))}%`,
                background: utilColor(util),
              }}
            />
          </div>
          <span className="branch-util-val" style={{ color: utilColor(util) }}>
            {pct(util)}
          </span>
          <span className="muted small">{active ? "avg GPU" : "avg GPU while running"}</span>
        </div>

        <div className="branch-cost">
          <span className="branch-cost-val">{usd(cost?.cost ?? 0, 2)}</span>
          <span className="muted small">
            {unlabeled ? "cost, branch unknown" : active ? "spent so far" : "final cost"}
          </span>
        </div>
      </div>

      {active && (
        <div className="branch-chips">
          {live!.ids.map((id) => (
            <span key={id} className="branch-chip mono" style={{ borderColor: `${color}66`, color }}>
              {id}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function BranchRail({
  live,
  costs,
  colorFor,
  now,
  trackingSince,
}: {
  live: Branch[];
  costs: BranchCost[];
  colorFor: (branch: string) => string;
  now: number;
  trackingSince: number | null;
}) {
  const costByName = new Map(costs.map((c) => [c.label, c]));
  const liveNames = new Set(live.map((b) => b.branch));
  // Active branches first, then finished ones most-recent-first. A branch that
  // ended this morning keeps its row and its final cost -- that retrospective
  // is the reason the history is persisted at all.
  const finished = costs
    .filter((c) => !liveNames.has(c.label))
    .sort((a, b) => b.last_seen - a.last_seen);

  return (
    <section className="card branch-card">
      <div className="card-head">
        <span className="card-title">Branches</span>
        <span className="head-right muted small">
          {live.length} active
          {finished.length ? ` · ${finished.length} finished` : ""}
          {trackingSince ? ` · costs measured since ${ago(now - trackingSince)}` : ""}
        </span>
      </div>
      <div className="branch-list">
        {live.length === 0 && finished.length === 0 && (
          <div className="muted small">No branches seen yet.</div>
        )}
        {live.map((b) => (
          <Band
            key={b.branch}
            name={b.branch}
            color={colorFor(b.branch)}
            live={b}
            cost={costByName.get(b.branch) ?? null}
            now={now}
          />
        ))}
        {finished.map((c) => (
          <Band key={c.label} name={c.label} color={colorFor(c.label)} live={null} cost={c} now={now} />
        ))}
      </div>
    </section>
  );
}
