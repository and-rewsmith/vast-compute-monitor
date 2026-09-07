import type { Branch, BranchCost } from "../types";
import { ago, duration, pct, usd, utilColor } from "../format";

// Samples recorded before branch tracking existed carry no label. They are real
// measurements and their cost is real, but they are NOT a branch that ran and
// finished -- so the band says what they actually are rather than inventing a
// lifecycle for them.
const UNLABELED = "(unlabeled)";

function Band({
  name,
  color,
  live,
  cost,
  now,
  windowLabel,
}: {
  name: string;
  color: string;
  live: Branch | null;
  cost: BranchCost | null;
  now: number;
  windowLabel: string;
}) {
  const active = live != null;
  const unlabeled = name === UNLABELED;
  const util = live?.gpu_util ?? cost?.avg_gpu_util ?? null;
  const ranFor = cost ? cost.last_seen - cost.first_seen : null;
  const endedAgo = cost && !active ? now - cost.last_seen : null;
  // The branch was already running when the window opened, so the cost below
  // covers only the visible slice of its life. Saying "spent so far" there
  // would quietly mean something different from the row beneath it.
  const partial = cost?.truncated ?? false;

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
              : `${cost?.instances ?? 0} inst · seen ${duration(ranFor)} of this window`}
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
          <span className="muted small">{active ? "avg GPU" : `avg GPU over ${windowLabel}`}</span>
        </div>

        <div className="branch-cost">
          <span className="branch-cost-val">{usd(cost?.cost ?? 0, 2)}</span>
          <span className="muted small">
            {unlabeled
              ? "cost, branch unknown"
              : partial
                ? `spent in ${windowLabel} (started earlier)`
                : active
                  ? `spent in ${windowLabel}`
                  : `cost over ${windowLabel}`}
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
  windowLabel,
  windowStart,
}: {
  live: Branch[];
  costs: BranchCost[];
  colorFor: (branch: string) => string;
  now: number;
  windowLabel: string;
  windowStart: number;
}) {
  const costByName = new Map(costs.map((c) => [c.label, c]));
  const liveNames = new Set(live.map((b) => b.branch));

  // `costs` is already window-scoped by the server, so a branch that finished
  // before the window opened simply is not in it. Active branches are always
  // in-window by definition -- they are being sampled right now.
  const finished = costs
    .filter((c) => !liveNames.has(c.label) && c.last_seen >= windowStart)
    .sort((a, b) => b.last_seen - a.last_seen);

  return (
    <section className="card branch-card">
      <div className="card-head">
        <span className="card-title">Branches · {windowLabel}</span>
        <span className="head-right muted small">
          {live.length} active
          {finished.length ? ` · ${finished.length} finished in window` : ""}
        </span>
      </div>
      <div className="branch-list">
        {live.length === 0 && finished.length === 0 && (
          <div className="muted small">No branches active in the last {windowLabel}.</div>
        )}
        {live.map((b) => (
          <Band
            key={b.branch}
            name={b.branch}
            color={colorFor(b.branch)}
            live={b}
            cost={costByName.get(b.branch) ?? null}
            now={now}
            windowLabel={windowLabel}
          />
        ))}
        {finished.map((c) => (
          <Band
            key={c.label}
            name={c.label}
            color={colorFor(c.label)}
            live={null}
            cost={c}
            now={now}
            windowLabel={windowLabel}
          />
        ))}
      </div>
    </section>
  );
}
