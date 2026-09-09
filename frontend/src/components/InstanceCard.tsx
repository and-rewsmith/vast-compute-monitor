import { useMemo } from "react";
import type { GpuPoint, GpuReading, HistoryPoint, Instance } from "../types";
import { ago, duration, gb, pct, rate, usd } from "../format";
import { Gauge } from "./Gauge";
import { Sparkline } from "./Sparkline";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

// Vast's lifecycle states, mapped to the three things a reader cares about:
// burning money productively, burning money idle, or not running.
function StatusPill({ inst }: { inst: Instance }) {
  const s = inst.status;
  if (inst.is_running) return <span className="pill ok">running</span>;
  if (s === "loading" || s === "created") return <span className="pill warn">{s}</span>;
  return <span className="pill off">{s}</span>;
}

// One physical GPU: its own compute and VRAM dials, its own thermals, and its
// own utilization trace. This is the whole point of the SSH probe -- the API
// averages a multi-GPU instance into a single number, which reported 49.5% for
// a box whose two cards were at 99% and 0%.
function GpuBlock({
  gpu,
  color,
  points,
  windowLabel,
}: {
  gpu: GpuReading;
  color: string;
  points: GpuPoint[];
  windowLabel: string;
}) {
  return (
    <div className="gpu-block">
      <div className="gpu-block-head">
        <span className="gpu-block-idx" style={{ color, borderColor: `${color}55` }}>
          GPU {gpu.index}
        </span>
        <span className="muted small">
          {gpu.temp_c != null ? `${Math.round(gpu.temp_c)}°C` : "—"}
          {gpu.power_w != null ? ` · ${Math.round(gpu.power_w)}W` : ""}
        </span>
      </div>
      <div className="gpu-block-dials">
        <Gauge value={gpu.util} label="compute" size={78} colorFn={() => color} />
        <Gauge
          value={gpu.mem_percent}
          label="VRAM"
          size={78}
          colorFn={() => color}
        />
      </div>
      <div className="gpu-block-vram muted small">
        {gpu.mem_used_mb != null && gpu.mem_total_mb
          ? `${gb(gpu.mem_used_mb / 1024)} / ${gb(gpu.mem_total_mb / 1024)}`
          : "—"}
      </div>
      <div className="gpu-block-spark">
        <div className="spark-head">
          <span className="stat-label">util · {windowLabel}</span>
          <span className="spark-now">{pct(gpu.util)}</span>
        </div>
        <Sparkline values={points.map((p) => p.util)} color={color} max={100} height={26} />
      </div>
    </div>
  );
}

export function InstanceCard({
  inst,
  branch,
  color,
  points,
  gpuSeries,
  windowLabel,
}: {
  inst: Instance;
  branch: string;
  color: string;
  points: HistoryPoint[];
  gpuSeries: Record<string, GpuPoint[]>;
  windowLabel: string;
}) {
  const cpuHist = points.map((p) => p.cpu_util);
  const probe = inst.gpu_probe;

  // Per-GPU blocks must not collapse into a single averaged dial just because
  // the live probe cache is cold. That cache is in-memory, so every backend
  // restart empties it, and the card would briefly swap layout and throw away
  // the per-GPU detail that is the entire reason this view exists.
  //
  // The per-GPU HISTORY is in SQLite and survives, so when the live reading is
  // missing the blocks are rebuilt from each GPU's most recent stored sample
  // and marked stale. The layout holds; only the numbers age.
  const gpus: GpuReading[] = useMemo(() => {
    const live = inst.gpus ?? [];
    if (live.length) return live;

    const prefix = `${inst.id}:`;
    const recovered: GpuReading[] = [];
    for (const [key, series] of Object.entries(gpuSeries)) {
      if (!key.startsWith(prefix) || !series.length) continue;
      const idx = Number(key.slice(prefix.length));
      if (!Number.isFinite(idx)) continue;
      let last: GpuPoint | null = null;
      for (let i = series.length - 1; i >= 0; i--) {
        if (series[i].util != null || series[i].mem_percent != null) {
          last = series[i];
          break;
        }
      }
      if (!last) continue;
      recovered.push({
        index: idx,
        name: inst.gpu_name ?? "GPU",
        util: last.util,
        mem_used_mb: last.mem_used_mb,
        mem_total_mb: last.mem_total_mb,
        mem_percent: last.mem_percent,
        temp_c: last.temp_c,
        power_w: last.power_w,
        sm_clock_mhz: null,
      });
    }
    recovered.sort((a, b) => a.index - b.index);
    return recovered;
  }, [inst.gpus, inst.id, inst.gpu_name, gpuSeries]);

  const liveGpus = (inst.gpus ?? []).length > 0;

  // Max, not mean: thermally the card that matters is the one running hottest.
  const hottest = (() => {
    const temps = gpus.map((g) => g.temp_c).filter((t): t is number => t != null);
    return temps.length ? Math.max(...temps) : inst.gpu_temp_c;
  })();

  // Fallback for an instance the probe has not reached (still booting, SSH
  // blocked, key missing). The API's single averaged reading is shown instead,
  // explicitly labelled as the average of N cards rather than dressed up as
  // per-GPU detail that was never measured.
  let lastGpu: number | null = inst.gpu_util;
  let lastGpuTs: number | null = null;
  if (lastGpu == null) {
    for (let i = points.length - 1; i >= 0; i--) {
      if (points[i].gpu_util != null) {
        lastGpu = points[i].gpu_util;
        lastGpuTs = points[i].ts;
        break;
      }
    }
  }
  const gpuAge = lastGpuTs != null ? Date.now() / 1000 - lastGpuTs : null;

  return (
    <div className={`card inst-card${inst.is_running ? "" : " inst-off"}`}>
      {/* Branch first and largest: it is what the reader is tracking. The
          instance id is a machine detail and sits under it as a mono chip. */}
      <div className="inst-head">
        <span className="inst-branch" style={{ color }} title={branch}>
          {branch}
        </span>
        <StatusPill inst={inst} />
      </div>
      <div className="inst-subhead">
        <span className="inst-id mono" style={{ borderColor: `${color}55` }}>
          {inst.id}
        </span>
        <span className="muted small">
          {inst.num_gpus}× {inst.gpu_name ?? "GPU"}
        </span>
      </div>

      {gpus.length > 0 ? (
        <>
          <div className="gpu-blocks">
            {gpus.map((g) => (
              <GpuBlock
                key={g.index}
                gpu={g}
                color={color}
                points={gpuSeries[`${inst.id}:${g.index}`] ?? []}
                windowLabel={windowLabel}
              />
            ))}
          </div>
          {!liveGpus ? (
            <div className="muted small probe-note">
              Per-GPU values from the last stored reading — live probe has not
              reported yet{probe?.error ? ` (${probe.error})` : ""}.
            </div>
          ) : (
            probe?.age_s != null &&
            probe.age_s > 120 && (
              <div className="muted small probe-note">
                per-GPU reading {ago(probe.age_s)}
                {probe.error ? ` — ${probe.error}` : ""}
              </div>
            )
          )}
        </>
      ) : (
        <>
          <div className="gpu-gauges">
            <Gauge
              value={lastGpu}
              label={
                inst.num_gpus > 1
                  ? `GPU · avg of ${inst.num_gpus}`
                  : gpuAge != null
                    ? `GPU · ${ago(gpuAge)}`
                    : "GPU compute"
              }
              stale={inst.gpu_util == null}
              colorFn={() => color}
            />
            <Gauge
              value={inst.vram_percent}
              label="VRAM"
              colorFn={() => color}
              sublabel={`${gb(inst.vram_used_gb)} / ${gb(inst.vram_total_gb)}`}
            />
          </div>
          <div className="muted small probe-note">
            {/* Say why the detail is missing. Silently showing an average where
                the reader expects per-GPU numbers is the failure mode here. */}
            No per-GPU data
            {probe?.error ? ` — ${probe.error}` : ""}
            {inst.num_gpus > 1 ? ". Values above are Vast's average across all cards." : "."}
          </div>
        </>
      )}

      <div className="gpu-stats">
        <Stat label="CPU" value={pct(inst.cpu_util)} />
        <Stat label="RAM" value={pct(inst.ram_percent)} />
        <Stat label="Disk" value={pct(inst.disk_percent)} />
        {/* Hottest card, from the same probe the blocks above use. Reading
            Vast's instance-level figure here contradicted them outright: it
            printed an em dash beside blocks showing 45/50/42/55 C. */}
        <Stat label="GPU temp" value={hottest != null ? `${Math.round(hottest)}°C` : "—"} />
      </div>

      {/* CPU stays instance-level: it is one pool shared by every GPU on the
          box, so there is no per-GPU number to split it into. */}
      <div className="inst-sparks single">
        <div className="spark-cell">
          <div className="spark-head">
            <span className="stat-label">CPU util · {windowLabel} · whole instance</span>
            <span className="spark-now">{pct(inst.cpu_util)}</span>
          </div>
          <Sparkline values={cpuHist} color={color} max={100} />
        </div>
      </div>

      <div className="inst-meta">
        <div className="meta-row">
          <span className="meta-label">Cost</span>
          <span className="meta-val">
            {usd(inst.dph_total)}/hr · {usd((inst.dph_total ?? 0) * 24, 2)}/day
          </span>
        </div>
        <div className="meta-row">
          <span className="meta-label">Uptime</span>
          <span className="meta-val">{duration(inst.uptime_s)}</span>
        </div>
        <div className="meta-row">
          <span className="meta-label">Net ↓↑</span>
          <span className="meta-val">
            {rate(inst.net_recv_bps)} / {rate(inst.net_sent_bps)}
          </span>
        </div>
        <div className="meta-row">
          <span className="meta-label">Disk</span>
          <span className="meta-val">
            {gb(inst.disk_used_gb)} / {gb(inst.disk_total_gb)}
          </span>
        </div>
        <div className="meta-row">
          <span className="meta-label">Where</span>
          <span className="meta-val" title={inst.geolocation ?? ""}>
            {inst.geolocation ?? "—"}
          </span>
        </div>
        <div className="meta-row">
          <span className="meta-label">SSH</span>
          <span className="meta-val mono ssh-line" title={`ssh -p ${inst.ssh_port} root@${inst.ssh_host}`}>
            {inst.ssh_host ? `${inst.ssh_host}:${inst.ssh_port}` : "—"}
          </span>
        </div>
        <div className="meta-row">
          <span className="meta-label">Image</span>
          <span className="meta-val" title={inst.image ?? ""}>
            {inst.image ?? "—"}
          </span>
        </div>
      </div>
    </div>
  );
}
