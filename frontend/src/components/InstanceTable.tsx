import { useMemo, useState } from "react";
import type { Instance } from "../types";
import { duration, pct, rate, usd } from "../format";

// GPU utilization for the table, taken from the SAME source as the instance
// cards: the per-GPU nvidia-smi probe, averaged across the instance's cards.
//
// Previously this column read Vast's `gpu_util`, which is a different
// measurement entirely -- and one this app nulls out whenever the host skips a
// telemetry tick. So the table would print an em dash, or 49%, beside a card
// whose dials plainly showed 99% and 0%. Same readings, same number, no
// conflict. Falls back to Vast's figure only when the probe has not reached the
// instance, and says so.
function gpuUtilFor(inst: Instance): { value: number | null; probed: boolean } {
  const gpus = inst.gpus ?? [];
  const vals = gpus.map((g) => g.util).filter((v): v is number => v != null);
  if (vals.length) {
    return { value: vals.reduce((a, b) => a + b, 0) / vals.length, probed: true };
  }
  return { value: inst.gpu_util, probed: false };
}

type Key =
  | "label" | "id" | "status" | "gpu_name" | "gpu_util" | "cpu_util" | "ram_percent"
  | "vram_percent" | "disk_percent" | "net_recv_bps" | "dph_total"
  | "uptime_s" | "geolocation";

const COLUMNS: { key: Key; label: string; num: boolean }[] = [
  { key: "label", label: "Branch", num: false },
  { key: "id", label: "ID", num: false },
  { key: "status", label: "Status", num: false },
  { key: "gpu_name", label: "GPU", num: false },
  { key: "gpu_util", label: "GPU %", num: true },
  { key: "cpu_util", label: "CPU %", num: true },
  { key: "vram_percent", label: "VRAM %", num: true },
  { key: "ram_percent", label: "RAM %", num: true },
  { key: "disk_percent", label: "Disk %", num: true },
  { key: "net_recv_bps", label: "Net ↓", num: true },
  { key: "dph_total", label: "$/hr", num: true },
  { key: "uptime_s", label: "Uptime", num: true },
  { key: "geolocation", label: "Location", num: false },
];

// The table view is also the accessibility fallback for the charts above: every
// number a line or tooltip shows is reachable here without hovering, and each
// row is keyed by the same series color as its line.
export function InstanceTable({
  instances,
  colorFor,
  branchOf,
}: {
  instances: Instance[];
  colorFor: (id: number) => string;
  branchOf: (inst: Instance) => string;
}) {
  const [sort, setSort] = useState<Key>("label");
  const [desc, setDesc] = useState(false);

  const rows = useMemo(() => {
    const copy = [...instances];
    copy.sort((a, b) => {
      const pick = (i: Instance) =>
        sort === "label"
          ? branchOf(i)
          : sort === "gpu_util"
            ? gpuUtilFor(i).value
            : (i[sort] as number | string | null);
      const av = pick(a) as number | string | null;
      const bv = pick(b) as number | string | null;
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av).localeCompare(String(bv));
      return desc ? -cmp : cmp;
    });
    return copy;
  }, [instances, sort, desc, branchOf]);

  const click = (k: Key) => {
    if (k === sort) setDesc((d) => !d);
    else {
      setSort(k);
      setDesc(true);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">All instances</span>
        <span className="head-right muted small">{instances.length} rented</span>
      </div>
      <div className="mini-scroll">
        <table className="mini-table">
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  className={`sortable${sort === c.key ? " sorted" : ""}${c.num ? " num" : ""}`}
                  onClick={() => click(c.key)}
                >
                  {c.label}
                  {sort === c.key ? (desc ? " ↓" : " ↑") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.id}>
                <td className="branch-cell" title={branchOf(i)}>
                  <span className="row-key" style={{ background: colorFor(i.id) }} />
                  {branchOf(i)}
                </td>
                <td className="mono muted">{i.id}</td>
                <td>
                  <span className={`pill ${i.is_running ? "ok" : "off"}`}>{i.status}</span>
                </td>
                <td>
                  {i.num_gpus}× {i.gpu_name ?? "—"}
                </td>
                <td
                  className="num"
                  title={
                    (i.gpus ?? []).length
                      ? (i.gpus ?? [])
                          .map((g) => `GPU ${g.index}: ${g.util == null ? "—" : `${Math.round(g.util)}%`}`)
                          .join("  ·  ")
                      : "No per-GPU probe data; showing Vast's own averaged figure."
                  }
                >
                  {(() => {
                    const { value, probed } = gpuUtilFor(i);
                    return (
                      <>
                        {pct(value)}
                        {!probed && value != null ? <span className="muted"> api</span> : null}
                      </>
                    );
                  })()}
                </td>
                <td className="num">{pct(i.cpu_util)}</td>
                <td className="num">{pct(i.vram_percent)}</td>
                <td className="num">{pct(i.ram_percent)}</td>
                <td className="num">{pct(i.disk_percent)}</td>
                <td className="num">{rate(i.net_recv_bps)}</td>
                <td className="num">{usd(i.dph_total)}</td>
                <td className="num">{duration(i.uptime_s)}</td>
                <td className="loc" title={i.geolocation ?? ""}>{i.geolocation ?? "—"}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length} className="muted" style={{ textAlign: "center", padding: "16px" }}>
                  No instances rented on this account.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="muted small table-foot">
        GPU % is the mean across the instance's cards, from the same per-GPU
        probe the cards above use — hover a cell for the per-GPU breakdown.
        Rows marked "api" fall back to Vast's own averaged figure because the
        probe could not reach that instance. Disk totals include stopped
        instances, which still bill storage.
      </div>
    </div>
  );
}
