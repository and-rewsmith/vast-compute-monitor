import { useMemo, useState } from "react";
import type { Instance } from "../types";
import { duration, pct, rate, usd, utilColor } from "../format";

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
      const av = (sort === "label" ? branchOf(a) : a[sort]) as number | string | null;
      const bv = (sort === "label" ? branchOf(b) : b[sort]) as number | string | null;
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
                <td className="num" style={{ color: utilColor(i.gpu_util) }}>{pct(i.gpu_util)}</td>
                <td className="num" style={{ color: utilColor(i.cpu_util) }}>{pct(i.cpu_util)}</td>
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
        GPU % and CPU % are coloured for value-for-money — green is busy, red is
        idle spend. VRAM / RAM / Disk use the opposite scale, where full is the
        thing to worry about. GPU % is blank where the host skipped its report;
        disk totals include stopped instances, which still bill storage.
      </div>
    </div>
  );
}
