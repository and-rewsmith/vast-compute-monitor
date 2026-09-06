// Mirrors the normalized record built in backend/app/vast.py. Units are fixed
// there and documented here so no component has to guess:
//   *_util / *_percent  percent 0-100      *_gb   gigabytes
//   *_bps               bytes/sec          dph_*  US dollars per hour
export interface Instance {
  id: number;
  label: string | null;
  status: string;
  intended_status: string | null;
  status_msg: string | null;
  is_running: boolean;

  gpu_name: string | null;
  num_gpus: number;
  gpu_frac: number | null;
  // null when the host did not report this tick -- NOT the same as 0. See the
  // staleness note in vast.py; charts draw a gap rather than a fake zero.
  gpu_util: number | null;
  gpu_temp_c: number | null;
  gpu_reporting: boolean;
  vram_used_gb: number | null;
  vram_total_gb: number | null;
  vram_percent: number | null;
  cuda: number | null;
  driver_version: string | null;
  compute_cap: number | null;
  total_flops: number | null;
  dlperf: number | null;

  cpu_name: string | null;
  cpu_cores: number | null;
  cpu_cores_effective: number | null;
  cpu_util: number | null;
  ram_used_gb: number | null;
  ram_total_gb: number | null;
  ram_percent: number | null;

  disk_used_gb: number | null;
  disk_total_gb: number | null;
  disk_percent: number | null;
  disk_name: string | null;
  disk_bw_mbps: number | null;

  net_recv_bps: number | null;
  net_sent_bps: number | null;
  link_down_mbps: number | null;
  link_up_mbps: number | null;
  down_billed_gb: number | null;
  up_billed_gb: number | null;

  dph_total: number | null;
  dph_base: number | null;
  storage_cost_dph: number | null;

  machine_id: number;
  host_id: number;
  geolocation: string | null;
  country_code: string | null;
  public_ipaddr: string | null;
  ssh_host: string | null;
  ssh_port: number;
  direct_port: number;
  image: string | null;
  os_version: string | null;
  reliability: number | null;
  pcie_bw_gbps: number | null;
  pci_gen: number | null;
  start_date: number | null;
  uptime_s: number | null;
}

export interface Fleet {
  total: number;
  running: number;
  gpus: number;
  dph_total: number;
  dph_running: number;
  avg_gpu_util: number | null;
  avg_cpu_util: number | null;
  vram_used_gb: number;
  vram_total_gb: number;
  ram_used_gb: number;
  ram_total_gb: number;
  disk_used_gb: number;
  disk_total_gb: number;
  net_recv_bps: number;
  net_sent_bps: number;
  idle_dph: number;
}

export interface Snapshot {
  type: "snapshot";
  ts: number;
  instances: Instance[];
  fleet: Fleet;
  error: string | null;
  stale_since?: number;
  interval: number;
}

export interface HistoryPoint {
  ts: number;
  is_running: boolean;
  gpu_util: number | null;
  cpu_util: number | null;
  gpu_temp_c: number | null;
  vram_used_gb: number | null;
  vram_total_gb: number | null;
  ram_used_gb: number | null;
  ram_total_gb: number | null;
  disk_used_gb: number | null;
  disk_total_gb: number | null;
  net_recv_bps: number | null;
  net_sent_bps: number | null;
  dph_total: number | null;
}

export interface History {
  start: number;
  end: number;
  minutes: number;
  bucket_s: number;
  series: Record<string, HistoryPoint[]>;
}

export interface Info {
  interval: number;
  api_key_tail: string;
  store: {
    samples: number;
    oldest: number | null;
    newest: number | null;
    db_bytes: number;
    db_path: string;
    retention_days: number;
  } | null;
}
