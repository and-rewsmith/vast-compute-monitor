import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BranchCost,
  BranchHistory,
  BranchPoint,
  History,
  HistoryPoint,
  Info,
  GpuHistory,
  GpuPoint,
  Snapshot,
  Spend,
} from "../types";

export type ConnState = "connecting" | "open" | "closed";

// Same-origin websocket, so the identical build works over localhost, LAN,
// Tailscale or the Vite dev proxy with no per-environment configuration.
function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws`;
}

export function useSnapshot() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [state, setState] = useState<ConnState>("connecting");
  const retry = useRef(0);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;

    const connect = () => {
      if (closed) return;
      setState("connecting");
      ws = new WebSocket(wsUrl());
      ws.onopen = () => {
        retry.current = 0;
        setState("open");
      };
      ws.onmessage = (ev) => {
        try {
          setSnapshot(JSON.parse(ev.data));
        } catch {
          // A malformed frame must not kill the stream; wait for the next tick.
        }
      };
      ws.onclose = () => {
        setState("closed");
        if (closed) return;
        const delay = Math.min(5000, 250 * 2 ** retry.current);
        retry.current += 1;
        timer.current = window.setTimeout(connect, delay);
      };
      ws.onerror = () => ws?.close();
    };

    connect();
    return () => {
      closed = true;
      if (timer.current) window.clearTimeout(timer.current);
      ws?.close();
    };
  }, []);

  return { snapshot, state };
}

export interface WindowOption {
  label: string;
  minutes: number;
}

export const WINDOWS: WindowOption[] = [
  { label: "15m", minutes: 15 },
  { label: "1h", minutes: 60 },
  { label: "6h", minutes: 360 },
  { label: "24h", minutes: 1440 },
  { label: "7d", minutes: 10080 },
  // Matches the store's 30-day retention, so the selector can reach everything
  // that is actually kept.
  { label: "30d", minutes: 43200 },
];

// History comes over HTTP rather than being seeded down the websocket: the
// window is user-selectable up to a week, which is far more than is sane to
// push to every tab on every reconnect. Live snapshots are then appended
// client-side so the right edge of each chart keeps moving between refetches.
export function useHistory(minutes: number, snapshot: Snapshot | null) {
  const [history, setHistory] = useState<History | null>(null);
  const [loading, setLoading] = useState(true);
  const lastAppended = useRef<number>(0);

  const refetch = useCallback(async () => {
    try {
      const r = await fetch(`/api/history?minutes=${minutes}&buckets=240`);
      const data: History = await r.json();
      setHistory(data);
      lastAppended.current = data.end;
    } catch {
      // A failed history fetch leaves the previous render on screen; the next
      // periodic refetch retries. Blanking the charts would be worse.
    } finally {
      setLoading(false);
    }
  }, [minutes]);

  useEffect(() => {
    setLoading(true);
    refetch();
  }, [refetch]);

  // Periodic full refetch so buckets re-form and the window slides. Tied to the
  // bucket width, not a fixed timer -- a 7-day chart has no reason to refetch
  // as often as a 15-minute one.
  useEffect(() => {
    const period = Math.max(30_000, ((minutes * 60) / 240) * 1000);
    const id = window.setInterval(refetch, period);
    return () => window.clearInterval(id);
  }, [refetch, minutes]);

  // Append each live snapshot to the tail of every instance's series.
  useEffect(() => {
    if (!snapshot || snapshot.error || !history) return;
    if (snapshot.ts <= lastAppended.current) return;
    lastAppended.current = snapshot.ts;
    setHistory((prev) => {
      if (!prev) return prev;
      const series: Record<string, HistoryPoint[]> = { ...prev.series };
      for (const inst of snapshot.instances) {
        const key = String(inst.id);
        const point: HistoryPoint = {
          ts: snapshot.ts,
          is_running: inst.is_running,
          gpu_util: inst.gpu_util,
          cpu_util: inst.cpu_util,
          gpu_temp_c: inst.gpu_temp_c,
          vram_used_gb: inst.vram_used_gb,
          vram_total_gb: inst.vram_total_gb,
          ram_used_gb: inst.ram_used_gb,
          ram_total_gb: inst.ram_total_gb,
          disk_used_gb: inst.disk_used_gb,
          disk_total_gb: inst.disk_total_gb,
          net_recv_bps: inst.net_recv_bps,
          net_sent_bps: inst.net_sent_bps,
          dph_total: inst.dph_total,
        };
        series[key] = (series[key] ?? []).concat(point);
      }
      return { ...prev, series, end: snapshot.ts };
    });
  }, [snapshot?.ts, history !== null]);

  return { history, loading, refetch };
}

export type GroupMode = "branch" | "instance";

// Per-branch utilization history. Same contract as useHistory (fetch on window
// change, append live snapshots, periodic refetch to re-form buckets) but keyed
// by branch, which is what the charts plot by default: three workers on one
// branch drew three identical lines, and one line with the branch name on it is
// the signal.
export function useBranchHistory(minutes: number, snapshot: Snapshot | null, enabled: boolean) {
  const [history, setHistory] = useState<BranchHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const lastAppended = useRef<number>(0);

  const refetch = useCallback(async () => {
    if (!enabled) return;
    try {
      const r = await fetch(`/api/branch-history?minutes=${minutes}&buckets=240`);
      const data: BranchHistory = await r.json();
      setHistory(data);
      lastAppended.current = data.end;
    } catch {
      // Leave the previous render up; the next periodic refetch retries.
    } finally {
      setLoading(false);
    }
  }, [minutes, enabled]);

  useEffect(() => {
    if (!enabled) return;
    setLoading(true);
    refetch();
  }, [refetch, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const period = Math.max(30_000, ((minutes * 60) / 240) * 1000);
    const id = window.setInterval(refetch, period);
    return () => window.clearInterval(id);
  }, [refetch, minutes, enabled]);

  useEffect(() => {
    if (!enabled || !snapshot || snapshot.error || !history) return;
    if (snapshot.ts <= lastAppended.current) return;
    lastAppended.current = snapshot.ts;
    setHistory((prev) => {
      if (!prev) return prev;
      const series: Record<string, BranchPoint[]> = { ...prev.series };
      for (const b of snapshot.branches) {
        const point: BranchPoint = {
          ts: snapshot.ts,
          instances: b.instances,
          gpus: b.gpus,
          gpu_util: b.gpu_util,
          // The live snapshot carries no per-branch CPU roll-up, so the tail of
          // the CPU series is computed here from the instances in this branch --
          // GPU-weighted, matching how the server aggregates it.
          cpu_util: weightedCpu(snapshot, b.ids),
          vram_percent: pooledVram(snapshot, b.ids),
          dph_total: b.dph_total,
          // Cost for the live tail point: one poll's worth at the current
          // price. Bounded by the poll interval, so appending it cannot invent
          // spend the way multiplying a rate across a gap would.
          cost: (b.dph_total * (snapshot.interval || 30)) / 3600,
        };
        series[b.branch] = (series[b.branch] ?? []).concat(point);
      }
      return { ...prev, series, end: snapshot.ts };
    });
  }, [snapshot?.ts, history !== null, enabled]);

  return { history, loading, refetch };
}

// Pooled, matching how the server aggregates it: total VRAM held over total
// allotted, so a nearly-full worker is not averaged away by an empty one.
function pooledVram(snapshot: Snapshot, ids: number[]): number | null {
  let used = 0;
  let total = 0;
  for (const id of ids) {
    const inst = snapshot.instances.find((i) => i.id === id);
    if (!inst || inst.vram_used_gb == null || !inst.vram_total_gb) continue;
    used += inst.vram_used_gb;
    total += inst.vram_total_gb;
  }
  return total ? (100 * used) / total : null;
}

function weightedCpu(snapshot: Snapshot, ids: number[]): number | null {
  let num = 0;
  let den = 0;
  for (const id of ids) {
    const inst = snapshot.instances.find((i) => i.id === id);
    if (!inst || !inst.is_running || inst.cpu_util == null) continue;
    num += inst.cpu_util * inst.num_gpus;
    den += inst.num_gpus;
  }
  return den ? num / den : null;
}

// The ledger + spend chart. Refetched on a timer rather than appended live: the
// periods are clock-bounded and the burn series is deliberately resampled onto a
// coarse baseline server-side, so there is no meaningful per-tick tail to add.
export function useSpend(minutes: number, snapshot: Snapshot | null) {
  const [spend, setSpend] = useState<Spend | null>(null);

  const refetch = useCallback(async () => {
    try {
      const r = await fetch(`/api/spend?minutes=${minutes}`);
      setSpend(await r.json());
    } catch {
      // Keep the last ledger on screen; the next tick retries.
    }
  }, [minutes]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useEffect(() => {
    const id = window.setInterval(refetch, 60_000);
    return () => window.clearInterval(id);
  }, [refetch]);

  // Nudge the ledger when the fleet's price changes -- adding or dropping a
  // worker is exactly when the numbers stop being current.
  const dph = snapshot?.fleet.dph_total ?? 0;
  useEffect(() => {
    refetch();
  }, [dph]);

  return { spend, refetch };
}

// Branch lifecycle + in-window cost, including branches that have finished.
// Scoped to the selector like everything else on the page: the rail sits above
// charts covering the same window, so a branch that finished outside it does
// not belong on screen.
export function useBranchCosts(minutes: number, snapshot: Snapshot | null) {
  const [branches, setBranches] = useState<BranchCost[]>([]);
  const refetch = useCallback(async () => {
    try {
      const r = await fetch(`/api/branches?minutes=${minutes}`);
      const d = await r.json();
      setBranches(d.branches ?? []);
    } catch {
      // Previous list stays; retried on the next interval.
    }
  }, [minutes]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useEffect(() => {
    const id = window.setInterval(refetch, 60_000);
    return () => window.clearInterval(id);
  }, [refetch]);
  const n = snapshot?.instances.length ?? 0;
  useEffect(() => {
    refetch();
  }, [n]);
  return branches;
}

// Per-GPU history, keyed "<instance_id>:<gpu_index>". Same append-live pattern
// as the others so each GPU's sparkline keeps moving between refetches.
export function useGpuHistory(minutes: number, snapshot: Snapshot | null) {
  const [history, setHistory] = useState<GpuHistory | null>(null);
  const lastAppended = useRef<number>(0);

  const refetch = useCallback(async () => {
    try {
      const r = await fetch(`/api/gpu-history?minutes=${minutes}&buckets=240`);
      const data: GpuHistory = await r.json();
      setHistory(data);
      lastAppended.current = data.end;
    } catch {
      // Keep the previous render; the next periodic refetch retries.
    }
  }, [minutes]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useEffect(() => {
    const period = Math.max(30_000, ((minutes * 60) / 240) * 1000);
    const id = window.setInterval(refetch, period);
    return () => window.clearInterval(id);
  }, [refetch, minutes]);

  useEffect(() => {
    if (!snapshot || snapshot.error || !history) return;
    if (snapshot.ts <= lastAppended.current) return;
    lastAppended.current = snapshot.ts;
    setHistory((prev) => {
      if (!prev) return prev;
      const series: Record<string, GpuPoint[]> = { ...prev.series };
      for (const inst of snapshot.instances) {
        for (const g of inst.gpus ?? []) {
          const key = `${inst.id}:${g.index}`;
          series[key] = (series[key] ?? []).concat({
            ts: snapshot.ts,
            util: g.util,
            mem_used_mb: g.mem_used_mb,
            mem_total_mb: g.mem_total_mb,
            mem_percent: g.mem_percent,
            temp_c: g.temp_c,
            power_w: g.power_w,
          });
        }
      }
      return { ...prev, series, end: snapshot.ts };
    });
  }, [snapshot?.ts, history !== null]);

  return history;
}

export function useInfo() {
  const [info, setInfo] = useState<Info | null>(null);
  useEffect(() => {
    fetch("/api/info")
      .then((r) => r.json())
      .then(setInfo)
      .catch(() => {});
  }, []);
  return info;
}
