import type { Fleet } from "../types";
import { gb, pct, rate, usd, utilColor } from "../format";
import { Gauge } from "./Gauge";

export function FleetPanel({ fleet }: { fleet: Fleet }) {
  const vramPct =
    fleet.vram_total_gb > 0 ? (100 * fleet.vram_used_gb) / fleet.vram_total_gb : null;

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Fleet</span>
        <span className="head-right muted small">
          {fleet.running}/{fleet.total} running · {fleet.gpus} GPUs
        </span>
      </div>
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
  );
}

export function CostPanel({ fleet }: { fleet: Fleet }) {
  const hr = fleet.dph_total;
  // Idle spend is the headline number this dashboard exists to surface: GPUs
  // you are renting that reported under 5% utilization on the latest poll.
  const idlePct = hr > 0 ? (100 * fleet.idle_dph) / hr : 0;

  return (
    <div className="card cost-card">
      <div className="card-head">
        <span className="card-title">Spend</span>
        <span className="head-right muted small">all rented instances</span>
      </div>
      <div className="cost-hero">
        <span className="cost-big">{usd(hr, 3)}</span>
        <span className="cost-unit">/hour</span>
      </div>
      <div className="cost-grid">
        <div className="stat">
          <div className="stat-label">Per day</div>
          <div className="stat-value">{usd(hr * 24, 2)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Per week</div>
          <div className="stat-value">{usd(hr * 24 * 7, 2)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Per 30d</div>
          <div className="stat-value">{usd(hr * 24 * 30, 0)}</div>
        </div>
      </div>
      <div className={`idle-box${fleet.idle_dph > 0 ? " idle-hot" : ""}`}>
        <div className="idle-head">
          <span className="stat-label">Idle spend</span>
          <span className="idle-val">{usd(fleet.idle_dph, 3)}/hr</span>
        </div>
        <div className="idle-track">
          <div
            className="idle-fill"
            style={{ width: `${Math.min(100, idlePct)}%` }}
          />
        </div>
        <div className="muted small">
          {fleet.idle_dph > 0
            ? `${idlePct.toFixed(0)}% of spend is on GPUs under 5% util · ${usd(fleet.idle_dph * 24, 2)}/day`
            : "every running GPU reported work on the last poll"}
        </div>
      </div>
    </div>
  );
}
