"""Vast.ai API client.

One call to `GET /api/v0/instances/` returns every instance on the account with
its live telemetry, so the whole dashboard is fed by a single request per poll.
This module owns two things and nothing else:

  1. Credential discovery (env var, then the vastai CLI's key file).
  2. Turning Vast's raw instance dict -- which mixes units freely (MB here, GB
     there, cumulative byte counters elsewhere) -- into one normalized record
     with explicit, documented units.

Everything downstream (store, websocket, UI) sees only the normalized shape.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from pathlib import Path

import httpx

API_BASE = os.environ.get("VAST_API_BASE", "https://console.vast.ai/api/v0")
KEY_FILE = Path(os.environ.get("VAST_API_KEY_FILE", Path.home() / ".config/vastai/vast_api_key"))

# Vast's cumulative billed-traffic counters are in KILOBYTES. This is not
# documented, so it was measured: instance 50090759's inet_down_billed advanced
# 1,782,579 units in ~380s. Read as MB that is 4.7 GB/s -- physically impossible
# on its 1027 Mbps link. Read as KB it is 37 Mbps, which fits. We diff these
# counters between polls to synthesize a live throughput rate (`_rate_bps`), so
# this constant sets the scale of every byte/sec figure the dashboard shows.
BILLED_UNIT_BYTES = 1024

# Instance states Vast considers "you are paying for compute right now".
RUNNING_STATES = {"running"}


class VastAuthError(RuntimeError):
    """No usable API key was found."""


def load_api_key() -> str:
    """VAST_API_KEY wins; otherwise reuse the key the `vastai` CLI already stores.

    Reusing the CLI's key file is deliberate: it means this dashboard needs no
    setup step on a machine where `vastai` is already logged in.
    """
    env = os.environ.get("VAST_API_KEY", "").strip()
    if env:
        return env
    if KEY_FILE.is_file():
        key = KEY_FILE.read_text().strip()
        if key:
            return key
    raise VastAuthError(
        f"No Vast API key. Set VAST_API_KEY or write one to {KEY_FILE} "
        f"(e.g. `vastai set api-key <key>`)."
    )


def _num(value: object) -> float | None:
    """Vast returns nulls, strings and NaNs interchangeably for numeric fields."""
    if value is None:
        return None
    try:
        f = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        # JUSTIFICATION FOR NO FAIL-FAST:
        # This is a wire-format coercion helper for a third-party API whose
        # numeric fields are not schema-guaranteed. A single unparseable field
        # must render as "no reading" in one cell, not take down the poller for
        # every instance. The absence is visible in the UI as an em dash.
        return None
    if f != f:  # NaN
        return None
    return f


def _pct(used: float | None, total: float | None) -> float | None:
    if used is None or total is None or total <= 0:
        return None
    return max(0.0, min(100.0, 100.0 * used / total))


@dataclass
class _NetCounter:
    """Last seen cumulative traffic counters for one instance."""

    ts: float
    down: float
    up: float


def _rate_bps(prev: float | None, cur: float | None, dt: float) -> float | None:
    """Bytes/sec from two cumulative counter readings.

    Returns None (not 0) when the delta is negative, which happens when the
    instance is recreated and Vast's counter restarts. Reporting a huge negative
    or a fake zero would both be wrong; "no reading" is the honest answer for
    that one interval.
    """
    if prev is None or cur is None or dt <= 0:
        return None
    delta = cur - prev
    if delta < 0:
        return None
    return (delta * BILLED_UNIT_BYTES) / dt


def normalize(raw: dict, prev_net: _NetCounter | None, now: float) -> dict:
    """Vast's raw instance dict -> the dashboard's normalized record.

    Units, made explicit because Vast's are not:
      * gpu_util, cpu_util   percent, 0-100 (gpu_util is None when the host
                             did not report -- see the staleness note below)
      * *_gb                 gigabytes
      * gpu_temp_c           degrees Celsius
      * net_*_bps            bytes/sec, derived from the billed-traffic deltas
      * dph_total            US dollars per hour, compute + storage
    """
    inst_id = int(raw.get("id"))

    # VRAM: `vmem_usage` is GB used; `gpu_totalram` is MB across all the GPUs
    # attached to this instance (gpu_ram is per-GPU).
    vram_used_gb = _num(raw.get("vmem_usage"))
    gpu_totalram_mb = _num(raw.get("gpu_totalram"))
    vram_total_gb = gpu_totalram_mb / 1024.0 if gpu_totalram_mb else None

    ram_used_gb = _num(raw.get("mem_usage"))
    ram_total_gb = _num(raw.get("mem_limit"))

    disk_used_gb = _num(raw.get("disk_usage"))
    disk_total_gb = _num(raw.get("disk_space"))

    down_billed = _num(raw.get("inet_down_billed"))
    up_billed = _num(raw.get("inet_up_billed"))
    dt = (now - prev_net.ts) if prev_net else 0.0
    net_recv_bps = _rate_bps(prev_net.down if prev_net else None, down_billed, dt)
    net_sent_bps = _rate_bps(prev_net.up if prev_net else None, up_billed, dt)

    start_date = _num(raw.get("start_date"))
    uptime_s = (now - start_date) if start_date else None

    status = str(raw.get("actual_status") or raw.get("cur_state") or "unknown")

    # ---- GPU telemetry staleness -----------------------------------------
    # Measured behaviour: Vast's per-instance GPU block goes missing on roughly
    # every other poll for some hosts, and when it does the API does not return
    # null -- it returns ZEROS. Instance 50079779 was observed alternating
    # (gpu_util=66.99, gpu_temp=44.5) -> (gpu_util=0.0, gpu_temp=0.0) on
    # consecutive 30s polls while running a steady workload.
    #
    # The two zeros always co-occur, and 0 C is not a temperature a powered GPU
    # reports, so gpu_temp==0 is a reliable marker for "the host did not report
    # this tick". Taking those zeros at face value would halve every utilization
    # average in the charts -- the single most misleading thing this dashboard
    # could do -- so both fields become None and the UI draws a gap.
    #
    # An idle GPU that IS reporting looks different and is preserved: instance
    # 50090759 steadily returns gpu_util=0.0 with gpu_temp=42, and that genuine
    # zero charts as zero.
    gpu_temp = _num(raw.get("gpu_temp"))
    gpu_util = _num(raw.get("gpu_util"))
    gpu_reporting = gpu_temp is not None and gpu_temp > 0
    if not gpu_reporting:
        gpu_temp = None
        gpu_util = None

    return {
        "id": inst_id,
        "label": raw.get("label"),
        "status": status,
        "intended_status": raw.get("intended_status"),
        "status_msg": raw.get("status_msg"),
        "is_running": status in RUNNING_STATES,
        # --- GPU -------------------------------------------------------------
        "gpu_name": raw.get("gpu_name"),
        "num_gpus": int(_num(raw.get("num_gpus")) or 0),
        "gpu_frac": _num(raw.get("gpu_frac")),
        "gpu_util": gpu_util,
        "gpu_temp_c": gpu_temp,
        "gpu_reporting": gpu_reporting,
        "vram_used_gb": vram_used_gb,
        "vram_total_gb": vram_total_gb,
        "vram_percent": _pct(vram_used_gb, vram_total_gb),
        "cuda": _num(raw.get("cuda_max_good")),
        "driver_version": raw.get("driver_version"),
        "compute_cap": _num(raw.get("compute_cap")),
        "total_flops": _num(raw.get("total_flops")),
        "dlperf": _num(raw.get("dlperf")),
        # --- CPU / RAM -------------------------------------------------------
        "cpu_name": raw.get("cpu_name"),
        "cpu_cores": _num(raw.get("cpu_cores")),
        "cpu_cores_effective": _num(raw.get("cpu_cores_effective")),
        "cpu_util": _num(raw.get("cpu_util")),
        "ram_used_gb": ram_used_gb,
        "ram_total_gb": ram_total_gb,
        "ram_percent": _pct(ram_used_gb, ram_total_gb),
        # --- Disk ------------------------------------------------------------
        "disk_used_gb": disk_used_gb,
        "disk_total_gb": disk_total_gb,
        "disk_percent": _pct(disk_used_gb, disk_total_gb),
        "disk_name": raw.get("disk_name"),
        "disk_bw_mbps": _num(raw.get("disk_bw")),
        # --- Network ---------------------------------------------------------
        "net_recv_bps": net_recv_bps,
        "net_sent_bps": net_sent_bps,
        "link_down_mbps": _num(raw.get("inet_down")),
        "link_up_mbps": _num(raw.get("inet_up")),
        "down_billed_gb": (down_billed * BILLED_UNIT_BYTES / 1e9) if down_billed else None,
        "up_billed_gb": (up_billed * BILLED_UNIT_BYTES / 1e9) if up_billed else None,
        # --- Cost ------------------------------------------------------------
        "dph_total": _num(raw.get("dph_total")),
        "dph_base": _num(raw.get("dph_base")),
        "storage_cost_dph": _num(raw.get("storage_total_cost")),
        # --- Placement / access ----------------------------------------------
        "machine_id": int(_num(raw.get("machine_id")) or 0),
        "host_id": int(_num(raw.get("host_id")) or 0),
        "geolocation": raw.get("geolocation"),
        "country_code": raw.get("country_code"),
        "public_ipaddr": raw.get("public_ipaddr"),
        "ssh_host": raw.get("ssh_host"),
        "ssh_port": int(_num(raw.get("ssh_port")) or 0),
        "direct_port": int(_num(raw.get("direct_port_start")) or 0),
        "image": raw.get("image_uuid"),
        "os_version": raw.get("os_version"),
        "reliability": _num(raw.get("reliability2")),
        "pcie_bw_gbps": _num(raw.get("pcie_bw")),
        "pci_gen": _num(raw.get("pci_gen")),
        "start_date": start_date,
        "uptime_s": uptime_s,
    }


class VastClient:
    """Polls the instances endpoint and normalizes the result.

    Holds the per-instance traffic counters needed to derive throughput rates,
    which is why it is a client object rather than a bare function.
    """

    def __init__(self, timeout: float = 20.0) -> None:
        self._key = load_api_key()
        self._client = httpx.Client(
            timeout=timeout,
            headers={"Authorization": f"Bearer {self._key}", "Accept": "application/json"},
        )
        self._net: dict[int, _NetCounter] = {}

    def close(self) -> None:
        self._client.close()

    def fetch_account(self) -> tuple[dict | None, str | None]:
        """Account-level balance and the cumulative spend counter.

        `total_spend` is the ground truth this dashboard bills against. It is a
        monotonically decreasing lifetime total, and -- unlike `credit` -- it is
        untouched by autobill top-ups, which lift the balance without being
        spend. Measured against the live account: credit and total_spend move by
        identical deltas while running, and only credit jumps on a top-up. So
        differencing total_spend gives realized dollars/hour with no top-up
        contamination and no dependence on our own dph integration.
        """
        try:
            resp = self._client.get(f"{API_BASE}/users/current/")
        except httpx.HTTPError as exc:
            # JUSTIFICATION FOR NO FAIL-FAST:
            # Same reasoning as fetch(): a transient upstream failure must not
            # kill a long-running poller. The instance telemetry is fetched
            # separately and still succeeds, so the dashboard degrades to
            # "no new spend reading this tick" rather than going dark.
            return None, f"{type(exc).__name__}: {exc}"
        if resp.status_code >= 400:
            return None, f"Vast API HTTP {resp.status_code} on users/current"
        try:
            raw = resp.json()
        except ValueError as exc:
            # JUSTIFICATION FOR NO FAIL-FAST: see above -- transient, retried.
            return None, f"unparseable account response: {exc}"

        return {
            "credit": _num(raw.get("credit")),
            # Stored as reported (negative, decreasing). Callers difference it;
            # nothing depends on the sign convention beyond that.
            "total_spend": _num(raw.get("total_spend")),
            "autobill_threshold": _num(raw.get("autobill_threshold")),
            "autobill_amount": _num(raw.get("autobill_amount")),
        }, None

    def fetch(self) -> tuple[list[dict], str | None]:
        """Return (instances, error). Never raises on a transient API problem.

        The dashboard's job is to keep showing the last good data with a visible
        "stale" marker when Vast is unreachable, so network/HTTP failures are
        returned as a message the UI renders rather than propagated. A missing
        API key is NOT caught here -- that is a configuration error and is
        raised at construction so the service fails fast at startup.
        """
        now = time.time()
        try:
            resp = self._client.get(f"{API_BASE}/instances/")
        except httpx.HTTPError as exc:
            # JUSTIFICATION FOR NO FAIL-FAST:
            # Vast's API being briefly unreachable is an expected operating
            # condition for a long-running poller, not a bug in this program.
            # Crashing would drop every connected browser and lose the poll
            # loop; instead the error is surfaced in the UI's status line and
            # the next tick retries.
            return [], f"{type(exc).__name__}: {exc}"

        if resp.status_code == 429:
            return [], "rate limited by Vast API (HTTP 429)"
        if resp.status_code in (401, 403):
            return [], f"Vast API rejected the key (HTTP {resp.status_code})"
        if resp.status_code >= 400:
            return [], f"Vast API HTTP {resp.status_code}"

        try:
            payload = resp.json()
        except ValueError as exc:
            # JUSTIFICATION FOR NO FAIL-FAST:
            # Same reasoning as the transport error above -- a malformed body
            # (Vast occasionally serves an HTML error page through its load
            # balancer) is a transient upstream condition, reported and retried.
            return [], f"unparseable response: {exc}"

        raw_list = payload.get("instances") or []
        out: list[dict] = []
        for raw in raw_list:
            if raw.get("id") is None:
                # JUSTIFICATION FOR NO FAIL-FAST:
                # An instance record with no id cannot be keyed, stored or
                # charted. Dropping the one unusable row is strictly better
                # than discarding the whole fleet's telemetry for that tick.
                continue
            inst_id = int(raw["id"])
            rec = normalize(raw, self._net.get(inst_id), now)
            down = _num(raw.get("inet_down_billed"))
            up = _num(raw.get("inet_up_billed"))
            if down is not None and up is not None:
                self._net[inst_id] = _NetCounter(ts=now, down=down, up=up)
            out.append(rec)

        # Forget counters for instances that no longer exist, so a recycled id
        # cannot inherit a stale baseline and report a bogus rate.
        live = {r["id"] for r in out}
        for gone in set(self._net) - live:
            del self._net[gone]

        out.sort(key=lambda r: r["id"])
        return out, None
