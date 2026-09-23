import { useEffect, useMemo, useRef, useState } from "react";
import {
  WINDOWS,
  useBranchCosts,
  useBranchHistory,
  useGpuHistory,
  useHistory,
  useInfo,
  useSnapshot,
  useSpend,
  type GroupMode,
} from "./api/useVast";
import type { BranchPoint, HistoryPoint, Instance } from "./types";
import { ago, gb, pct, seriesColor, usd } from "./format";
import { TimeChart, type ChartSeries } from "./components/TimeChart";
import { Legend } from "./components/Legend";
import { BranchRail } from "./components/BranchRail";
import { SpendChart } from "./components/SpendChart";
import { CumulativeSpend } from "./components/CumulativeSpend";
import { InstanceCard } from "./components/InstanceCard";
import { InstanceTable } from "./components/InstanceTable";

const UNLABELED = "(unlabeled)";

export function branchOf(inst: Instance): string {
  return (inst.label ?? "").trim() || UNLABELED;
}

// Colour follows the BRANCH now, not the instance -- the branch is the identity
// the reader is tracking, and its workers should share its colour. Assignment
// happens once on first sighting and is held for the life of the tab, so a
// branch finishing never repaints the others' lines mid-session.
function useBranchColors(names: string[]) {
  const assigned = useRef<Map<string, number>>(new Map());
  const next = useRef(0);
  for (const n of names) {
    if (!assigned.current.has(n)) {
      assigned.current.set(n, next.current);
      next.current += 1;
    }
  }
  return useMemo(() => {
    const map = assigned.current;
    return (name: string) => seriesColor(map.get(name) ?? 0);
  }, [names.join(" ")]);
}

export default function App() {
  const { snapshot, state } = useSnapshot();
  const info = useInfo();
  const [minutes, setMinutes] = useState(60);
  // Default to per-GPU: a multi-GPU box averaged into one line hides exactly the
  // split this dashboard exists to show, so that is never the first thing shown.
  const [group, setGroup] = useState<GroupMode>("gpu");
  const [now, setNow] = useState(() => Date.now() / 1000);

  const instHistory = useHistory(minutes, snapshot);
  const branchHistory = useBranchHistory(minutes, snapshot, group === "branch");
  const { spend } = useSpend(minutes, snapshot);
  const branchCosts = useBranchCosts(minutes, snapshot);
  const gpuHistory = useGpuHistory(minutes, snapshot);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => window.clearInterval(id);
  }, []);

  const instances = snapshot?.instances ?? [];
  const liveBranches = snapshot?.branches ?? [];

  // Every branch worth colouring: live, historical, and any appearing only in
  // the chart window.
  const branchNames = useMemo(() => {
    const s = new Set<string>();
    for (const b of liveBranches) s.add(b.branch);
    for (const c of branchCosts) s.add(c.label);
    for (const k of Object.keys(branchHistory.history?.series ?? {})) s.add(k);
    for (const k of Object.keys(spend?.branch_series ?? {})) s.add(k);
    return [...s].sort();
  }, [liveBranches, branchCosts, branchHistory.history, spend]);

  const colorForBranch = useBranchColors(branchNames);
  const colorForInstance = (id: number) => {
    const inst = instances.find((i) => i.id === id);
    return colorForBranch(inst ? branchOf(inst) : UNLABELED);
  };

  const windowLabel = WINDOWS.find((w) => w.minutes === minutes)?.label ?? `${minutes}m`;
  const loading = group === "branch" ? branchHistory.loading : instHistory.loading;

  // Chart series for the GPU / VRAM / CPU panels. Grouped three ways:
  //   branch    one line per branch (its workers pooled)
  //   instance  one line per instance (its GPUs averaged into one number)
  //   gpu       one line per PHYSICAL GPU (see gpuLineSeries) -- a 4-GPU box
  //             draws four lines and is never averaged into a single trace
  const makeSeries = (field: "gpu_util" | "cpu_util" | "vram_percent"): ChartSeries[] => {
    if (group === "branch") {
      const series = branchHistory.history?.series ?? {};
      return Object.keys(series)
        .sort()
        .map((name) => ({
          key: name,
          label: name,
          color: colorForBranch(name),
          points: series[name].map((p: BranchPoint) => ({ ts: p.ts, v: p[field] })),
        }));
    }
    const series = instHistory.history?.series ?? {};
    const ids = new Set<number>(instances.map((i) => i.id));
    for (const k of Object.keys(series)) ids.add(Number(k));
    return [...ids]
      .sort((a, b) => a - b)
      .map((id) => {
        const inst = instances.find((i) => i.id === id);
        return {
          key: String(id),
          label: inst ? `${id} - ${branchOf(inst)}` : String(id),
          color: colorForInstance(id),
          points: (series[String(id)] ?? []).map((p: HistoryPoint) => ({
            ts: p.ts,
            // Instance history stores VRAM in gigabytes, so the percentage is
            // derived here rather than stored twice.
            v:
              field === "vram_percent"
                ? p.vram_used_gb != null && p.vram_total_gb
                  ? (100 * p.vram_used_gb) / p.vram_total_gb
                  : null
                : p[field],
          })),
        };
      });
  };

  // One line per physical GPU, keyed "<id>:<idx>", from the same per-GPU history
  // the instance-card sparklines use. This is the whole point of the "gpu"
  // grouping: Vast's API averages a multi-GPU box into a single number (it
  // reported 49.5% for a pair of cards actually running 99% and 0%), and this
  // never does. Colour is by draw order from the categorical palette, NOT by
  // branch, so sibling GPUs on one box stay distinct rather than overplotting
  // in one hue.
  const gpuLineSeries = (metric: "util" | "mem_percent"): ChartSeries[] => {
    const series = gpuHistory?.series ?? {};
    return Object.keys(series)
      .sort((a, b) => {
        const [ai, ag] = a.split(":").map(Number);
        const [bi, bg] = b.split(":").map(Number);
        return ai - bi || ag - bg;
      })
      .map((key, i) => {
        const [idStr, gStr] = key.split(":");
        const id = Number(idStr);
        const inst = instances.find((x) => x.id === id);
        const branch = inst ? branchOf(inst) : String(id);
        return {
          key,
          label: `${id}·g${gStr} - ${branch}`,
          color: seriesColor(i),
          points: series[key].map((p) => ({ ts: p.ts, v: p[metric] })),
        };
      });
  };

  // GPU and VRAM honour the "gpu" grouping; CPU never does -- it is one pool
  // shared by every card on the box, so there is no per-GPU number to split it
  // into, and it falls back to the per-instance line.
  const gpuSeries = useMemo(
    () => (group === "gpu" ? gpuLineSeries("util") : makeSeries("gpu_util")),
    [group, branchHistory.history, instHistory.history, gpuHistory, instances],
  );
  const vramSeries = useMemo(
    () => (group === "gpu" ? gpuLineSeries("mem_percent") : makeSeries("vram_percent")),
    [group, branchHistory.history, instHistory.history, gpuHistory, instances],
  );
  const cpuSeries = useMemo(
    () => makeSeries("cpu_util"),
    [group, branchHistory.history, instHistory.history, instances],
  );
  // Each panel keys its own legend off its own series -- in "gpu" mode the GPU
  // and VRAM panels are per-card while CPU stays per-instance, so one shared
  // legend would mislabel the CPU lines.
  const legendOf = (s: ChartSeries[]) => s.map((x) => ({ key: x.key, label: x.label, color: x.color }));
  const noGpuData = group === "gpu" && gpuSeries.length === 0;

  const activeHistory = group === "branch" ? branchHistory.history : instHistory.history;
  const chartStart = activeHistory?.start ?? now - minutes * 60;
  const chartEnd = Math.max(activeHistory?.end ?? now, now);
  const sampleAge = snapshot ? now - snapshot.ts : null;
  const stale = snapshot?.error != null;

  // Instance cards, grouped under their branch.
  const grouped = useMemo(() => {
    const g = new Map<string, Instance[]>();
    for (const i of instances) {
      const b = branchOf(i);
      if (!g.has(b)) g.set(b, []);
      g.get(b)!.push(i);
    }
    return [...g.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [instances]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" data-state={stale ? "closed" : state} />
          <span className="host">Vast.ai</span>
          <span className="muted small">
            {snapshot
              ? `${snapshot.fleet.branches} branch${snapshot.fleet.branches === 1 ? "" : "es"} - ` +
                `${snapshot.fleet.running}/${snapshot.fleet.total} running - ` +
                `${snapshot.fleet.gpus} GPUs - ${usd(snapshot.fleet.dph_total)}/hr`
              : ""}
          </span>
        </div>
        <div className="topbar-right muted small">
          {snapshot?.account?.credit != null && <span>credit {usd(snapshot.account.credit, 2)}</span>}
          {info?.store?.samples ? <span>{info.store.samples.toLocaleString()} samples</span> : null}
          {sampleAge != null && <span>polled {ago(sampleAge)}</span>}
          <span className="conn" data-state={stale ? "closed" : state}>
            {stale
              ? "stale"
              : state === "open"
                ? "live"
                : state === "connecting"
                  ? "connecting"
                  : "reconnecting"}
          </span>
        </div>
      </header>

      {snapshot?.error && (
        <div className="banner">
          <strong>Vast API unreachable</strong> - {snapshot.error}. Showing the last good data
          {snapshot.stale_since ? `, from ${ago(now - snapshot.stale_since)}` : ""}.
        </div>
      )}

      {!snapshot ? (
        <div className="empty">
          {state === "open" ? "Waiting for the first poll" : "Connecting to backend"}
        </div>
      ) : (
        <main className="grid">
          <div className="filters">
            <span className="filter-label">Window</span>
            <div className="seg">
              {WINDOWS.map((w) => (
                <button
                  key={w.minutes}
                  className={`seg-btn${w.minutes === minutes ? " on" : ""}`}
                  onClick={() => setMinutes(w.minutes)}
                >
                  {w.label}
                </button>
              ))}
            </div>
            <span className="filter-label">Group by</span>
            <div className="seg">
              {(["branch", "instance", "gpu"] as GroupMode[]).map((m) => (
                <button
                  key={m}
                  className={`seg-btn${group === m ? " on" : ""}`}
                  onClick={() => setGroup(m)}
                >
                  {m}
                </button>
              ))}
            </div>
            <span className="muted small">
              polling every {Math.round(snapshot.interval)}s
              {activeHistory ? ` - ${Math.round(activeHistory.bucket_s)}s buckets` : ""}
            </span>
          </div>

          <BranchRail
            live={liveBranches}
            costs={branchCosts}
            colorFor={colorForBranch}
            now={now}
            windowLabel={windowLabel}
            windowStart={now - minutes * 60}
          />

          <section className="chart-row">
            <div className="card">
              <div className="card-head">
                <span className="card-title">GPU utilization - {windowLabel}</span>
                <span className="head-right muted small">
                  avg {pct(snapshot.fleet.avg_gpu_util)} across {snapshot.fleet.running} running
                </span>
              </div>
              <Legend items={legendOf(gpuSeries)} />
              {noGpuData && (
                <div className="muted small" style={{ padding: "2px 0 8px" }}>
                  No per-GPU probe data in this window yet — the SSH probe may not
                  have reached these hosts. Switch to “instance” for Vast’s figure.
                </div>
              )}
              <TimeChart
                series={gpuSeries}
                start={chartStart}
                end={chartEnd}
                windowMinutes={minutes}
                yMax={100}
                yFormat={(v) => `${Math.round(v)}%`}
                dimmed={loading}
              />
            </div>
            <div className="card">
              <div className="card-head">
                <span className="card-title">VRAM utilization - {windowLabel}</span>
                <span className="head-right muted small">
                  {gb(snapshot.fleet.vram_used_gb)} / {gb(snapshot.fleet.vram_total_gb)} pooled
                </span>
              </div>
              <Legend items={legendOf(vramSeries)} />
              {noGpuData && (
                <div className="muted small" style={{ padding: "2px 0 8px" }}>
                  No per-GPU probe data in this window yet.
                </div>
              )}
              <TimeChart
                series={vramSeries}
                start={chartStart}
                end={chartEnd}
                windowMinutes={minutes}
                yMax={100}
                yFormat={(v) => `${Math.round(v)}%`}
                dimmed={loading}
              />
            </div>
            <div className="card">
              <div className="card-head">
                <span className="card-title">CPU utilization - {windowLabel}</span>
                <span className="head-right muted small">
                  avg {pct(snapshot.fleet.avg_cpu_util)} across {snapshot.fleet.running} running
                  {group === "gpu" ? " · per instance" : ""}
                </span>
              </div>
              <Legend items={legendOf(cpuSeries)} />
              <TimeChart
                series={cpuSeries}
                start={chartStart}
                end={chartEnd}
                windowMinutes={minutes}
                yMax={100}
                yFormat={(v) => `${Math.round(v)}%`}
                dimmed={loading}
              />
            </div>
          </section>

          <section className="spend-row">
            <div className="card">
              <div className="card-head">
                <span className="card-title">Spend per hour - {windowLabel}</span>
                <span className="head-right muted small">
                  {spend?.trailing_burn.mean != null
                    ? `Vast is charging ${usd(spend.trailing_burn.mean)}/hr`
                    : `listed ${usd(snapshot.fleet.dph_total)}/hr`}
                </span>
              </div>
              {spend ? (
                <SpendChart spend={spend} colorFor={colorForBranch} windowMinutes={minutes} />
              ) : (
                <div className="muted small">Collecting spend samples</div>
              )}
            </div>
            <div className="card">
              <div className="card-head">
                <span className="card-title">Cumulative spend - {windowLabel}</span>
                <span className="head-right muted small">
                  {spend ? `${usd(spend.window_spent, 2)} charged in this window` : ""}
                </span>
              </div>
              {spend ? (
                <CumulativeSpend spend={spend} colorFor={colorForBranch} windowMinutes={minutes} />
              ) : (
                <div className="muted small">Collecting spend samples</div>
              )}
            </div>
          </section>

          <section className="inst-groups">
            {grouped.length === 0 ? (
              <div className="card muted noinst">No instances rented on this account right now.</div>
            ) : (
              grouped.map(([branch, members]) => (
                <div key={branch} className="inst-group">
                  <div className="group-head">
                    <span className="group-key" style={{ background: colorForBranch(branch) }} />
                    <span className="group-name">{branch}</span>
                    <span className="muted small">
                      {members.length} instance{members.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="inst-row">
                    {members.map((i) => (
                      <InstanceCard
                        key={i.id}
                        inst={i}
                        branch={branch}
                        color={colorForBranch(branch)}
                        points={instHistory.history?.series[String(i.id)] ?? []}
                        gpuSeries={gpuHistory?.series ?? {}}
                        windowLabel={windowLabel}
                      />
                    ))}
                  </div>
                </div>
              ))
            )}
          </section>

          <InstanceTable instances={instances} colorFor={colorForInstance} branchOf={branchOf} />
        </main>
      )}
    </div>
  );
}
