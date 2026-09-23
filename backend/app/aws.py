"""AWS EC2 source for the dashboard -- the second provider beside Vast.

The EGTO account runs GPU boxes from one launch template, every one tagged
`project=egto`, so a single `describe-instances` filtered on that tag is the
fleet, whoever owns it. That mirrors `egq box ls --fleet`; the field mapping
here follows `box_record_from_instance` in egq's `egq_aws.py` so the two agree
on what a box IS (provider, owner, spot, zone, instance type -> GPU).

Three things differ from Vast and drive the shape of this module:

  1. **Telemetry does not come with the fleet listing.** Vast returns live
     utilization in the same response as the instance list. EC2 does not: the
     numbers live in CloudWatch, published by the CloudWatch agent every 60s in
     the `CWAgent` namespace, dimensioned by InstanceId (and by GPU `index` for
     the nvidia metrics). So a poll here is two calls, not one.

  2. **We must not SSH into these boxes.** The per-GPU probe used for Vast holds
     an SSH master connection open (ControlPersist), and an EGTO box terminates
     itself after 30 idle minutes only if *nobody is logged in*. A dashboard
     that probes over SSH would silently keep idle boxes alive and billing --
     the exact failure this dashboard exists to make visible. CloudWatch gives
     us the same per-GPU numbers without touching the box, so `gpu_probe.py`
     skips anything whose provider is not "vast".

  3. **There is no long-lived credential, by policy.** The account's deny list
     blocks iam:CreateAccessKey outright, so a 24/7 poller cannot hold its own
     key: it rides the operator's SSO session and goes blind when that expires
     (daily). That is a *reported* state, not an error to hide -- `fetch`
     returns a message naming the credential and the command that fixes it.

Cost of polling, since this one bills by the call: `GetMetricData` is charged
per metric requested (~$0.01/1000). We request only running instances, only the
metrics below, at most once a minute -- a handful of cents a month at one box.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from datetime import datetime, timezone

REGION = os.environ.get("VASTMON_AWS_REGION", os.environ.get("EGTO_REGION", "us-east-1"))
PROFILE = os.environ.get("VASTMON_AWS_PROFILE", "me")
PROJECT_TAG = os.environ.get("VASTMON_AWS_PROJECT_TAG", "egto")
# The login the operator has to run when the session lapses; quoted back to them
# verbatim in the UI rather than a generic "credentials error".
LOGIN_HINT = f"aws sso login --profile {PROFILE}"

# States worth showing. A terminated box is gone and its history is already in
# the store; a stopped one still bills storage, so it stays on the board.
FLEET_STATES = "pending,running,stopping,stopped,shutting-down"
RUNNING_STATES = {"running"}

# us-east-1 on-demand, from the EGTO infra notes. Used only when the box is NOT
# spot: a spot box is billed at the live market price, which we read per zone.
ON_DEMAND_DPH = {
    "g6.xlarge": 0.8048,
    "g5.xlarge": 1.006,
    "g6e.xlarge": 1.861,
    "g6.12xlarge": 4.6016,
    "g5.12xlarge": 5.672,
    "t3.small": 0.0208,
}
# Accelerator per type, for the card name and the GPU count. The count matters:
# every fleet average in the dashboard is GPU-weighted.
GPU_BY_TYPE = {
    "g6": ("NVIDIA L4", {"xlarge": 1, "2xlarge": 1, "4xlarge": 1, "8xlarge": 1, "12xlarge": 4, "16xlarge": 1}),
    "g6e": ("NVIDIA L40S", {"xlarge": 1, "2xlarge": 1, "4xlarge": 1, "8xlarge": 1, "12xlarge": 4, "16xlarge": 1}),
    "g5": ("NVIDIA A10G", {"xlarge": 1, "2xlarge": 1, "4xlarge": 1, "8xlarge": 1, "12xlarge": 4, "16xlarge": 1, "24xlarge": 4, "48xlarge": 8}),
    "p4d": ("NVIDIA A100", {"24xlarge": 8}),
    "p5": ("NVIDIA H100", {"48xlarge": 8}),
}

# CloudWatch agent metric names vary with the agent's config, so they are
# DISCOVERED per instance (list-metrics) rather than assumed, and matched by
# these suffixes. A box whose agent publishes nothing simply has no GPU numbers,
# which the UI shows as a gap -- not as zero.
GPU_METRIC_SUFFIXES = {
    "utilization_gpu": "util",
    "memory_used": "mem_used_mb",
    "memory_total": "mem_total_mb",
    "temperature_gpu": "temp_c",
    "power_draw": "power_w",
}
HOST_METRIC_SUFFIXES = {
    "mem_used_percent": "ram_percent",
    "used_percent": "disk_percent",   # disk plugin; dimensioned by path
    "cpu_usage_active": "cpu_util",
}
# How far back to look for the newest datapoint. The agent publishes at 60s and
# CloudWatch lags a little; 15 minutes covers a slow publish without ever
# presenting a genuinely stale number as current (every reading is stamped with
# its age, and `main.prefer_probe_util` is not allowed near these records).
LOOKBACK_S = float(os.environ.get("VASTMON_AWS_LOOKBACK_S", "900"))
# Spot prices move slowly; re-reading them every poll would be a call per box
# per minute for a number that changes hourly.
PRICE_TTL_S = 600.0
CALL_TIMEOUT_S = float(os.environ.get("VASTMON_AWS_TIMEOUT_S", "45"))


class AwsError(RuntimeError):
    """An `aws` CLI call failed. The message is the CLI's own last line."""


def available() -> tuple[bool, str | None]:
    """Is the EC2 source usable at all on this machine?"""
    if os.environ.get("VASTMON_AWS", "1") not in ("1", "true", "yes"):
        return False, "AWS source disabled (VASTMON_AWS=0)"
    if shutil.which("aws") is None:
        return False, "aws CLI not found on PATH"
    return True, None


def _env() -> dict:
    env = dict(os.environ)
    env.setdefault("AWS_PROFILE", PROFILE)
    env["AWS_DEFAULT_REGION"] = REGION
    return env


def _aws(args: list[str], timeout: float = CALL_TIMEOUT_S) -> dict:
    cmd = ["aws", "--region", REGION, "--output", "json", *args]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=_env())
    if p.returncode != 0:
        err = (p.stderr or "").strip().splitlines()
        raise AwsError(err[-1] if err else f"aws {' '.join(args[:2])} failed ({p.returncode})")
    return json.loads(p.stdout) if p.stdout.strip() else {}


def explain(exc: Exception) -> str:
    """Turn an AWS failure into something the operator can act on.

    The expired-session case is the common one by far -- it happens every day by
    design -- and it must not read like a bug in the dashboard.
    """
    s = str(exc)
    expired = ("ExpiredToken", "expired", "SSO session", "sso session", "InvalidGrant",
               "refreshing credentials", "Error loading SSO Token")
    if any(k in s for k in expired):
        return f"AWS SSO session expired -- run: {LOGIN_HINT}"
    if "NoCredentials" in s or "Unable to locate credentials" in s:
        return f"no AWS credentials -- run: {LOGIN_HINT}"
    if "config profile" in s and "could not be found" in s:
        return f"AWS profile {PROFILE!r} is not configured (VASTMON_AWS_PROFILE)"
    if "AccessDenied" in s or "UnauthorizedOperation" in s:
        return f"AWS access denied: {s}"
    if isinstance(exc, subprocess.TimeoutExpired):
        return f"AWS call timed out after {CALL_TIMEOUT_S:.0f}s"
    return f"AWS: {s}"


def _num(v: object) -> float | None:
    try:
        f = float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return f if f == f else None


def _tags(inst: dict) -> dict:
    return {t["Key"]: t["Value"] for t in inst.get("Tags", [])}


def _launch_epoch(inst: dict) -> float | None:
    raw = inst.get("LaunchTime")
    if not raw:
        return None
    try:
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _gpu_spec(itype: str) -> tuple[str | None, int]:
    family, _, size = itype.partition(".")
    name, sizes = GPU_BY_TYPE.get(family, (None, {}))
    return name, sizes.get(size, 1 if name else 0)


def _dims(metric: dict) -> dict:
    return {d["Name"]: d["Value"] for d in metric.get("Dimensions", [])}


class AwsClient:
    """Polls the EGTO EC2 fleet and returns records shaped like Vast's.

    Everything downstream (store, websocket, UI) is provider-agnostic: it sees
    the same normalized keys with `provider` saying where they came from.
    """

    def __init__(self) -> None:
        # instance id -> discovered CloudWatch metrics; boxes are short-lived,
        # so this is cleared for ids that leave the fleet.
        self._metrics: dict[str, list[dict]] = {}
        self._price: dict[tuple[str, str, bool], tuple[float, float | None]] = {}

    # ---------------------------------------------------------------- pricing
    def _dph(self, itype: str, zone: str, spot: bool) -> float | None:
        """Dollars per hour for one box.

        For spot this is the CURRENT market price in the box's zone, which is
        what it is billed at -- not the price it launched at. It therefore
        drifts, and a cumulative-spend figure built from it is an estimate; the
        dashboard's Vast column has no such caveat, so the record carries
        `dph_estimated` to keep the two honest apart.
        """
        key = (itype, zone, spot)
        hit = self._price.get(key)
        if hit and time.time() - hit[0] < PRICE_TTL_S:
            return hit[1]
        price: float | None
        if spot:
            try:
                out = _aws([
                    "ec2", "describe-spot-price-history",
                    "--instance-types", itype,
                    "--product-descriptions", "Linux/UNIX",
                    "--availability-zone", zone,
                    "--max-items", "1",
                ])
                hist = out.get("SpotPriceHistory") or []
                price = _num(hist[0]["SpotPrice"]) if hist else None
            except (AwsError, subprocess.TimeoutExpired, KeyError, IndexError):
                # JUSTIFICATION FOR NO FAIL-FAST:
                # A missing price must not cost us the utilization numbers in
                # the same poll. The box shows with no cost rather than not at
                # all, and the next poll retries.
                price = None
        else:
            price = ON_DEMAND_DPH.get(itype)
        self._price[key] = (time.time(), price)
        return price

    # ------------------------------------------------------------- cloudwatch
    def _discover(self, instance_id: str) -> list[dict]:
        """Which CWAgent metrics does this box actually publish?"""
        if instance_id in self._metrics:
            return self._metrics[instance_id]
        try:
            out = _aws([
                "cloudwatch", "list-metrics",
                "--namespace", "CWAgent",
                "--dimensions", f"Name=InstanceId,Value={instance_id}",
            ])
            found = out.get("Metrics") or []
        except (AwsError, subprocess.TimeoutExpired):
            found = []
        wanted = []
        for m in found:
            name = m.get("MetricName", "")
            if any(name.endswith(sfx) for sfx in GPU_METRIC_SUFFIXES) or \
               any(name.endswith(sfx) for sfx in HOST_METRIC_SUFFIXES):
                wanted.append(m)
        # Only cache a non-empty discovery: the agent needs a minute after boot
        # to publish anything, and caching the empty answer would blind the box
        # for as long as it lives.
        if wanted:
            self._metrics[instance_id] = wanted
        return wanted

    def _read_metrics(self, ids: list[str]) -> dict[str, dict]:
        """One GetMetricData call for the whole fleet.

        Returns {instance_id: {"gpus": {index: {...}}, "host": {...}, "age_s": s}}
        """
        queries: list[dict] = []
        index: dict[str, tuple[str, str, str | None]] = {}   # qid -> (instance, field, gpu index)
        for inst_id in ids:
            for m in self._discover(inst_id):
                name = m["MetricName"]
                dims = _dims(m)
                gpu_index = dims.get("index")
                field = None
                for sfx, key in GPU_METRIC_SUFFIXES.items():
                    if name.endswith(sfx):
                        field = key
                        break
                if field is None:
                    for sfx, key in HOST_METRIC_SUFFIXES.items():
                        if name.endswith(sfx):
                            # The disk plugin publishes used_percent per mount;
                            # only the root filesystem is the box's "disk full?"
                            if key == "disk_percent" and dims.get("path") not in (None, "/"):
                                field = None
                                break
                            field = key
                            break
                if field is None:
                    continue
                qid = f"q{len(queries)}"
                queries.append({
                    "Id": qid,
                    "MetricStat": {
                        "Metric": {"Namespace": "CWAgent", "MetricName": name,
                                   "Dimensions": m.get("Dimensions", [])},
                        "Period": 60,
                        "Stat": "Average",
                    },
                    "ReturnData": True,
                })
                index[qid] = (inst_id, field, gpu_index)
            # EC2's own metrics need no agent, so CPU and network are here even
            # on a box whose agent is not up yet. Basic monitoring publishes at
            # 300s; the period below must not be finer than that or the call
            # returns empty for boxes without detailed monitoring.
            for metric, field in (("CPUUtilization", "cpu_util"),
                                  ("NetworkIn", "net_recv_bps"),
                                  ("NetworkOut", "net_sent_bps")):
                qid = f"q{len(queries)}"
                queries.append({
                    "Id": qid,
                    "MetricStat": {
                        "Metric": {"Namespace": "AWS/EC2", "MetricName": metric,
                                   "Dimensions": [{"Name": "InstanceId", "Value": inst_id}]},
                        "Period": 300,
                        "Stat": "Average",
                    },
                    "ReturnData": True,
                })
                index[qid] = (inst_id, f"ec2:{field}", None)

        if not queries:
            return {}

        now = time.time()
        out = _aws([
            "cloudwatch", "get-metric-data",
            "--start-time", datetime.fromtimestamp(now - LOOKBACK_S, timezone.utc).isoformat(),
            "--end-time", datetime.fromtimestamp(now, timezone.utc).isoformat(),
            "--scan-by", "TimestampDescending",
            "--metric-data-queries", json.dumps(queries),
        ])

        result: dict[str, dict] = {}
        for res in out.get("MetricDataResults", []):
            qid = res.get("Id")
            if qid not in index or not res.get("Values"):
                continue
            inst_id, field, gpu_index = index[qid]
            value = _num(res["Values"][0])
            stamp = res.get("Timestamps") or []
            age = None
            if stamp:
                try:
                    age = now - datetime.fromisoformat(str(stamp[0]).replace("Z", "+00:00")).timestamp()
                except ValueError:
                    age = None
            slot = result.setdefault(inst_id, {"gpus": {}, "host": {}, "age_s": None})
            if age is not None:
                slot["age_s"] = age if slot["age_s"] is None else min(slot["age_s"], age)
            if gpu_index is not None:
                slot["gpus"].setdefault(int(gpu_index), {})[field] = value
            elif field.startswith("ec2:"):
                slot["host"].setdefault(field[4:], value)
            else:
                # An agent reading wins over the EC2 one for the same field:
                # cpu_usage_active is per-minute, CPUUtilization per-5-minutes.
                slot["host"][field] = value
        # NetworkIn/Out are BYTES PER PERIOD, not a rate. Divide by the period
        # or every throughput figure on the board is 300x too big.
        for slot in result.values():
            for key in ("net_recv_bps", "net_sent_bps"):
                if slot["host"].get(key) is not None:
                    slot["host"][key] = slot["host"][key] / 300.0
        return result

    # ------------------------------------------------------------- normalize
    def _record(self, inst: dict, metrics: dict, now: float, metrics_error: str | None = None) -> dict:
        inst_id = inst["InstanceId"]
        tags = _tags(inst)
        itype = inst.get("InstanceType") or ""
        state = (inst.get("State") or {}).get("Name") or "unknown"
        zone = (inst.get("Placement") or {}).get("AvailabilityZone") or ""
        spot = inst.get("InstanceLifecycle") == "spot"
        gpu_name, num_gpus = _gpu_spec(itype)

        m = metrics.get(inst_id) or {"gpus": {}, "host": {}, "age_s": None}
        host = m["host"]
        gpus = []
        for idx in sorted(m["gpus"]):
            g = m["gpus"][idx]
            used, total = g.get("mem_used_mb"), g.get("mem_total_mb")
            gpus.append({
                "index": idx,
                "name": gpu_name,
                "util": g.get("util"),
                "mem_used_mb": used,
                "mem_total_mb": total,
                "mem_percent": (100.0 * used / total) if used is not None and total else None,
                "temp_c": g.get("temp_c"),
                "power_w": g.get("power_w"),
                "sm_clock_mhz": None,
            })
        # The card count CloudWatch reports beats the table: it is what the box
        # actually has, and the table is a guess keyed on the type string.
        if gpus:
            num_gpus = len(gpus)

        utils = [g["util"] for g in gpus if g.get("util") is not None]
        gpu_util = (sum(utils) / len(utils)) if utils else None
        temps = [g["temp_c"] for g in gpus if g.get("temp_c") is not None]
        vram_used = sum(g["mem_used_mb"] for g in gpus if g.get("mem_used_mb") is not None) / 1024.0 if gpus else None
        vram_total = sum(g["mem_total_mb"] for g in gpus if g.get("mem_total_mb") is not None) / 1024.0 if gpus else None

        started = _launch_epoch(inst)
        # The branch grouping key, which the dashboard treats as "several
        # workers doing one piece of work". Measured against the real fleet the
        # tags rank: `agent` names the worker and groups its boxes together;
        # `Name` is "egto-<owner>", which would collapse everything one person
        # runs into a single band; `repo_ref` is usually a 40-char sha, exact
        # but unreadable as a heading, so it is abbreviated and used last. The
        # full sha stays on the record either way. VASTMON_AWS_LABEL_TAG picks
        # one tag explicitly and skips this order.
        forced = os.environ.get("VASTMON_AWS_LABEL_TAG", "")
        ref = tags.get("repo_ref") or ""
        short_ref = ref[:12] if len(ref) == 40 and all(c in "0123456789abcdef" for c in ref) else ref
        label = (tags.get(forced) if forced else "") or tags.get("agent") or tags.get("Name") or short_ref or ""
        dph = self._dph(itype, zone, spot) if state in RUNNING_STATES else None

        return {
            "id": inst_id,
            "provider": "ec2",
            "label": label,
            "status": state,
            "intended_status": state,
            "status_msg": (inst.get("StateTransitionReason") or "") or None,
            "is_running": state in RUNNING_STATES,
            # --- GPU ---------------------------------------------------------
            "gpu_name": gpu_name,
            "num_gpus": int(num_gpus or 0),
            "gpu_frac": 1.0,
            "gpu_util": gpu_util,
            "gpu_temp_c": (sum(temps) / len(temps)) if temps else None,
            "gpu_reporting": bool(gpus),
            "gpus": gpus,
            # Named like the SSH probe's block so the UI's "where did this
            # number come from" affordances work unchanged, but it is CloudWatch
            # and no session is ever opened to the box. See module docstring.
            "gpu_probe": {
                "ok": bool(gpus),
                # Distinguish the two ways this comes up empty. "The agent on
                # this box publishes no GPU metrics" is a fact about the box;
                # "CloudWatch would not answer" is a fact about us. Reporting
                # the second as the first sends the reader to the wrong box.
                "error": None if gpus else (metrics_error or "no CWAgent nvidia metrics published"),
                "age_s": m["age_s"],
                "source": "cloudwatch",
            },
            "gpu_util_src": "cwagent" if gpus else "none",
            "api_gpu_util": None,
            "vram_used_gb": vram_used,
            "vram_total_gb": vram_total,
            "vram_percent": (100.0 * vram_used / vram_total) if vram_used is not None and vram_total else None,
            "cuda": None,
            "driver_version": None,
            "compute_cap": None,
            "total_flops": None,
            "dlperf": None,
            # --- CPU / RAM ---------------------------------------------------
            "cpu_name": itype,
            "cpu_cores": _num((inst.get("CpuOptions") or {}).get("CoreCount")),
            "cpu_cores_effective": None,
            "cpu_util": host.get("cpu_util"),
            "ram_used_gb": None,
            "ram_total_gb": None,
            "ram_percent": host.get("ram_percent"),
            # --- Disk --------------------------------------------------------
            "disk_used_gb": None,
            "disk_total_gb": None,
            "disk_percent": host.get("disk_percent"),
            "disk_name": None,
            "disk_bw_mbps": None,
            # --- Network -----------------------------------------------------
            "net_recv_bps": host.get("net_recv_bps"),
            "net_sent_bps": host.get("net_sent_bps"),
            "link_down_mbps": None,
            "link_up_mbps": None,
            "down_billed_gb": None,
            "up_billed_gb": None,
            # --- Cost --------------------------------------------------------
            "dph_total": dph,
            "dph_base": dph,
            "storage_cost_dph": None,
            # A spot box is billed at the live price, so this figure drifts and
            # anything cumulative built on it is an estimate. Flagged, not hidden.
            "dph_estimated": bool(spot),
            # --- Placement / access ------------------------------------------
            "machine_id": 0,
            "host_id": 0,
            "geolocation": zone,
            "country_code": None,
            "public_ipaddr": inst.get("PublicIpAddress"),
            # The instance id IS the ssh target: ~/.ssh/config routes `Host i-*`
            # over Session Manager. Recorded for the operator to copy -- NOT for
            # this process to connect to (module docstring, point 2).
            "ssh_host": inst_id,
            "ssh_port": 22,
            "direct_port": 0,
            "image": inst.get("ImageId"),
            "os_version": None,
            "reliability": None,
            "pcie_bw_gbps": None,
            "pci_gen": None,
            "start_date": started,
            "uptime_s": (now - started) if started else None,
            # --- EC2 specifics the UI can show without a per-provider branch --
            "instance_type": itype,
            "spot": spot,
            "zone": zone,
            "aws_owner": tags.get("owner"),
            "agent": tags.get("agent") or "",
            "repo_ref": ref,
            "short_ref": short_ref,
        }

    # ------------------------------------------------------------------ fetch
    def fetch(self) -> tuple[list[dict], str | None]:
        """The EC2 half of a poll: (records, error). Never raises."""
        ok, why = available()
        if not ok:
            return [], why
        try:
            out = _aws([
                "ec2", "describe-instances",
                "--filters", f"Name=tag:project,Values={PROJECT_TAG}",
                f"Name=instance-state-name,Values={FLEET_STATES}",
            ])
        except (AwsError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
            return [], explain(exc)

        fleet = [i for r in out.get("Reservations", []) for i in r.get("Instances", [])]
        live = {i["InstanceId"] for i in fleet}
        for gone in set(self._metrics) - live:
            del self._metrics[gone]

        running = [i["InstanceId"] for i in fleet if (i.get("State") or {}).get("Name") in RUNNING_STATES]
        metrics: dict[str, dict] = {}
        metrics_error: str | None = None
        if running:
            try:
                metrics = self._read_metrics(running)
            except (AwsError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
                # JUSTIFICATION FOR NO FAIL-FAST:
                # The fleet listing already succeeded. Losing telemetry for one
                # poll must not also lose the fact that the boxes EXIST and are
                # costing money -- that is the half of the dashboard that still
                # works without any metrics at all.
                metrics = {}
                metrics_error = explain(exc)

        now = time.time()
        return [self._record(i, metrics, now, metrics_error) for i in fleet], None
