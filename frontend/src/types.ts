// Mirrors the normalized record built in backend/app/vast.py. Units are fixed
// there and documented here so no component has to guess:
//   *_util / *_percent  percent 0-100      *_gb   gigabytes
//   *_bps               bytes/sec          dph_*  US dollars per hour
// One physical GPU, from nvidia-smi on the instance. Vast's API cannot supply
// this -- it reports a single averaged number per instance regardless of GPU
// count -- so these come from the SSH probe and may be absent.
export interface GpuReading {
  index: number;
  name: string;
  util: number | null;
  mem_used_mb: number | null;
  mem_total_mb: number | null;
  mem_percent: number | null;
  temp_c: number | null;
  power_w: number | null;
  sm_clock_mhz: number | null;
}

export interface GpuProbeStatus {
  ok: boolean;
  error: string | null;
  age_s: number | null;
}

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
  // Authoritative GPU utilization: the per-GPU probe's mean across this
  // instance's cards when a fresh reading exists, Vast's figure otherwise.
  // null when neither has a reading this tick -- NOT the same as 0.
  gpu_util: number | null;
  // Vast's own figure, kept for comparison. It is not trusted to drive charts:
  // one host reported 0% for hours while its four cards ran at 99%.
  api_gpu_util?: number | null;
  gpu_util_src?: "probe" | "api";
  gpu_temp_c: number | null;
  gpu_reporting: boolean;
  // Per-GPU breakdown; empty when the probe could not reach the instance.
  gpus: GpuReading[];
  gpu_probe: GpuProbeStatus | null;
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
  branches: number;
}

// A branch is the unit of work: instances are labelled with the branch name and
// several workers routinely share one, so the label groups rather than names.
export interface Branch {
  branch: string;
  instances: number;
  running: number;
  gpus: number;
  dph_total: number;
  gpu_util: number | null;
  ids: number[];
  started: number | null;
}

export interface Account {
  credit: number | null;
  // Cumulative lifetime spend, reported negative and decreasing. Differenced to
  // get realized burn; unlike credit it is untouched by autobill top-ups.
  total_spend: number | null;
  autobill_threshold: number | null;
  autobill_amount: number | null;
}

export interface Snapshot {
  type: "snapshot";
  ts: number;
  instances: Instance[];
  fleet: Fleet;
  branches: Branch[];
  account: Account | null;
  error: string | null;
  stale_since?: number;
  interval: number;
}

export interface BranchPoint {
  ts: number;
  instances: number;
  gpus: number;
  gpu_util: number | null;
  cpu_util: number | null;
  // Pooled across the branch's workers: total VRAM held over total allotted.
  vram_percent: number | null;
  dph_total: number | null;
  // Dollars accrued inside this bucket, integrated server-side with a capped
  // interval. Never re-derive this from dph and bucket spacing: across a gap
  // where the branch was not running that inference invents spend.
  cost: number | null;
}

export interface BranchHistory {
  start: number;
  end: number;
  minutes: number;
  bucket_s: number;
  series: Record<string, BranchPoint[]>;
}

export interface TrailingBurn {
  window_s: number;
  samples: number;
  lo: number | null;
  hi: number | null;
  mean: number | null;
}

export interface Spend {
  now: number;
  tracking_since: number | null;
  trailing_burn: TrailingBurn;
  // Realized spend over the requested window -- not a clock period.
  window_spent: number;
  window_coverage: number;
  branch_series: Record<string, BranchPoint[]>;
  start: number;
  end: number;
  bucket_s: number;
  account_burn: { ts: number; burn_hr: number; cum: number | null }[];
}

export interface BranchCost {
  label: string;
  // Lifecycle *within the selected window*.
  first_seen: number;
  last_seen: number;
  // Lifecycle across everything retained, regardless of window.
  first_seen_all: number | null;
  last_seen_all: number | null;
  // The branch was already running when the window opened, so `cost` covers
  // only part of its life and must not be read as a lifetime total.
  truncated: boolean;
  instances: number;
  // Cost accrued inside the window, not over the branch's lifetime.
  cost: number;
  avg_gpu_util: number | null;
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

export interface GpuPoint {
  ts: number;
  util: number | null;
  mem_used_mb: number | null;
  mem_total_mb: number | null;
  mem_percent: number | null;
  temp_c: number | null;
  power_w: number | null;
}

export interface GpuHistory {
  start: number;
  end: number;
  minutes: number;
  bucket_s: number;
  // Keyed "<instance_id>:<gpu_index>".
  series: Record<string, GpuPoint[]>;
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
