import type { Fleet } from "../types";
import { gb, pct, rate, utilColor } from "../format";
import { Gauge } from "./Gauge";

export function FleetPanel({ fleet }: { fleet: Fleet }) {
  const vramPct =
    fleet.vram_total_gb > 0 ? (100 * fleet.vram_used_gb) / fleet.vram_total_gb : null;

  return (
    <div className="card fleet-card">
      <div className="card-head">
        <span className="card-title">Fleet</span>
        <span className="head-right muted small">
          {fleet.running}/{fleet.total} running · {fleet.gpus} GPUs
        </span>
      </div>
      <div className="fleet-inner">
      <div className="gpu-gauges">
        <Gauge value={fleet.avg_gpu_util} label="Avg GPU" colorFn={utilColor} />
        <Gauge value={fleet.avg_cpu_util} label="Avg CPU" colorFn={utilColor} />
        <Gauge
          value={vramPct}
          label="VRAM"
          sublabel={`${gb(fleet.vram_used_gb)} / ${gb(fleet.vram_total_gb)}`}
        />
      </div>
      <div className="gpu-stats">
        <div className="stat">
          <div className="stat-label">RAM</div>
          <div className="stat-value">{pct(fleet.ram_total_gb > 0 ? (100 * fleet.ram_used_gb) / fleet.ram_total_gb : null)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Disk</div>
          <div className="stat-value">{gb(fleet.disk_used_gb, 0)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Net ↓</div>
          <div className="stat-value">{rate(fleet.net_recv_bps)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Net ↑</div>
          <div className="stat-value">{rate(fleet.net_sent_bps)}</div>
        </div>
      </div>
      </div>
    </div>
  );
}
