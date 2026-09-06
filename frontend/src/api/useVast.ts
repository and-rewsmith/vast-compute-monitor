import { useCallback, useEffect, useRef, useState } from "react";
import type { History, HistoryPoint, Info, Snapshot } from "../types";

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
