import { useEffect, useMemo, useRef, useState } from "react";
import { WINDOWS, useHistory, useInfo, useSnapshot } from "./api/useVast";
import type { HistoryPoint, Instance } from "./types";
import { ago, pct, seriesColor, usd } from "./format";
import { TimeChart, type ChartSeries } from "./components/TimeChart";
import { Legend } from "./components/Legend";
import { CostPanel, FleetPanel } from "./components/FleetPanel";
import { InstanceCard } from "./components/InstanceCard";
import { InstanceTable } from "./components/InstanceTable";

// Color follows the instance, not its position in the current list. Assignment
// happens once, on first sighting, and is held for the life of the tab -- so
// destroying one instance never repaints the others' lines mid-session.
function useColorMap(instances: Instance[]) {
  const assigned = useRef<Map<number, number>>(new Map());
  const next = useRef(0);
  for (const i of instances) {
    if (!assigned.current.has(i.id)) {
      assigned.current.set(i.id, next.current);
      next.current += 1;
    }
  }
  return useMemo(() => {
    const map = assigned.current;
    return (id: number) => seriesColor(map.get(id) ?? 0);
  }, [instances.map((i) => i.id).join(",")]);
}

export default function App() {
  const { snapshot, state } = useSnapshot();
  const info = useInfo();
  const [minutes, setMinutes] = useState(60);
  const { history, loading } = useHistory(minutes, snapshot);
  const [now, setNow] = useState(() => Date.now() / 1000);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => window.clearInterval(id);
  }, []);

  const instances = snapshot?.instances ?? [];
  const colorFor = useColorMap(instances);
  const windowLabel = WINDOWS.find((w) => w.minutes === minutes)?.label ?? `${minutes}m`;

  // Every instance that appears in EITHER the live list or the history window,
  // so a box destroyed an hour ago keeps its line on a 6h chart instead of
  // silently vanishing.
  const seriesIds = useMemo(() => {
    const ids = new Set<number>(instances.map((i) => i.id));
    for (const key of Object.keys(history?.series ?? {})) ids.add(Number(key));
    return [...ids].sort((a, b) => a - b);
  }, [instances, history]);

  const labelFor = (id: number) => {
    const inst = instances.find((i) => i.id === id);
    return inst?.label ? `${id} · ${inst.label}` : String(id);
  };

  const makeSeries = (field: "gpu_util" | "cpu_util"): ChartSeries[] =>
    seriesIds.map((id) => ({
      key: String(id),
      label: labelFor(id),
      color: colorFor(id),
      points: (history?.series[String(id)] ?? []).map((p: HistoryPoint) => ({
        ts: p.ts,
        v: p[field],
      })),
    }));

  const gpuSeries = useMemo(() => makeSeries("gpu_util"), [history, seriesIds]);
  const cpuSeries = useMemo(() => makeSeries("cpu_util"), [history, seriesIds]);
  const legendItems = seriesIds.map((id) => ({
    key: String(id),
    label: labelFor(id),
    color: colorFor(id),
    muted: !instances.some((i) => i.id === id),
  }));

  const chartStart = history?.start ?? now - minutes * 60;
  const chartEnd = Math.max(history?.end ?? now, now);
  const sampleAge = snapshot ? now - snapshot.ts : null;
  const stale = snapshot?.error != null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" data-state={stale ? "closed" : state} />
          <span className="host">Vast.ai</span>
          <span className="muted small">
            {snapshot
              ? `${snapshot.fleet.running}/${snapshot.fleet.total} running · ${snapshot.fleet.gpus} GPUs · ${usd(snapshot.fleet.dph_total, 3)}/hr`
              : ""}
          </span>
        </div>
        <div className="topbar-right muted small">
          {info?.store?.samples ? <span>{info.store.samples.toLocaleString()} samples stored</span> : null}
          {sampleAge != null && <span>polled {ago(sampleAge)}</span>}
          <span className="conn" data-state={stale ? "closed" : state}>
            {stale ? "stale" : state === "open" ? "live" : state === "connecting" ? "connecting…" : "reconnecting…"}
          </span>
        </div>
      </header>

      {snapshot?.error && (
        <div className="banner">
          <strong>Vast API unreachable</strong> — {snapshot.error}. Showing the last
          good data{snapshot.stale_since ? `, from ${ago(now - snapshot.stale_since)}` : ""}.
        </div>
      )}

      {!snapshot ? (
        <div className="empty">
          {state === "open" ? "Waiting for the first poll…" : "Connecting to backend…"}
        </div>
      ) : (
        <main className="grid">
          {/* Filters sit in one row above everything they scope. */}
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
            <span className="muted small">
              polling every {Math.round(snapshot.interval)}s
              {history ? ` · ${Math.round(history.bucket_s)}s buckets` : ""}
            </span>
          </div>

          <section className="chart-row">
            <div className="card">
              <div className="card-head">
                <span className="card-title">GPU utilization · {windowLabel}</span>
                <span className="head-right muted small">avg {pct(snapshot.fleet.avg_gpu_util)}</span>
              </div>
              <Legend items={legendItems} />
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
                <span className="card-title">CPU utilization · {windowLabel}</span>
                <span className="head-right muted small">avg {pct(snapshot.fleet.avg_cpu_util)}</span>
              </div>
              <Legend items={legendItems} />
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

          <section className="summary-row">
            <FleetPanel fleet={snapshot.fleet} />
            <CostPanel fleet={snapshot.fleet} />
          </section>

          <section className="inst-row">
            {instances.length === 0 ? (
              <div className="card muted noinst">
                No instances rented on this account right now.
              </div>
            ) : (
              instances.map((i) => (
                <InstanceCard
                  key={i.id}
                  inst={i}
                  color={colorFor(i.id)}
                  points={history?.series[String(i.id)] ?? []}
                  windowLabel={windowLabel}
                />
              ))
            )}
          </section>

          <InstanceTable instances={instances} colorFor={colorFor} />
        </main>
      )}
    </div>
  );
}
