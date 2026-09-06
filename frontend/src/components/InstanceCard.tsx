import type { HistoryPoint, Instance } from "../types";
import { ago, duration, gb, loadColor, pct, rate, tempColor, usd, utilColor } from "../format";
import { Gauge } from "./Gauge";
import { Sparkline } from "./Sparkline";

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={color ? { color } : undefined}>
        {value}
      </div>
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

export function InstanceCard({
  inst,
  branch,
  color,
  points,
  windowLabel,
}: {
  inst: Instance;
  branch: string;
  color: string;
  points: HistoryPoint[];
  windowLabel: string;
}) {
  const gpuHist = points.map((p) => p.gpu_util);
  const cpuHist = points.map((p) => p.cpu_util);

  // GPU telemetry arrives intermittently (see vast.py), so the gauge shows the
  // most recent real reading and says how old it is rather than blinking to a
  // dash every other poll.
  let lastGpu: number | null = inst.gpu_util;
  let lastGpuTs: number | null = inst.gpu_util != null ? points.length ? points[points.length - 1].ts : null : null;
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
  const gpuStale = inst.gpu_util == null;

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

      <div className="gpu-gauges">
        <Gauge
          value={lastGpu}
          label={gpuStale && gpuAge != null ? `GPU · ${ago(gpuAge)}` : "GPU compute"}
          stale={gpuStale}
          colorFn={utilColor}
        />
        <Gauge
          value={inst.vram_percent}
          label="VRAM"
          sublabel={`${gb(inst.vram_used_gb)} / ${gb(inst.vram_total_gb)}`}
        />
      </div>

      <div className="gpu-stats">
        <Stat
          label="GPU temp"
          value={inst.gpu_temp_c != null ? `${Math.round(inst.gpu_temp_c)}°C` : "—"}
          color={tempColor(inst.gpu_temp_c)}
        />
        <Stat label="CPU" value={pct(inst.cpu_util)} color={utilColor(inst.cpu_util)} />
        <Stat label="RAM" value={pct(inst.ram_percent)} color={loadColor(inst.ram_percent)} />
        <Stat label="Disk" value={pct(inst.disk_percent)} color={loadColor(inst.disk_percent)} />
      </div>

      <div className="inst-sparks">
        <div className="spark-cell">
          <div className="spark-head">
            <span className="stat-label">GPU util · {windowLabel}</span>
            <span className="spark-now">{pct(lastGpu)}</span>
          </div>
          <Sparkline values={gpuHist} color={color} max={100} />
        </div>
        <div className="spark-cell">
          <div className="spark-head">
            <span className="stat-label">CPU util · {windowLabel}</span>
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
