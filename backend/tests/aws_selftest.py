#!/usr/bin/env python
"""Self-test for the EC2 source, run against canned AWS responses.

    cd backend && .venv/bin/python tests/aws_selftest.py

No pytest, no network, no credentials: the repo has no test framework and this
needs none. What it is here for is the handful of conversions that are wrong
*quietly* -- a rate read as a total, a mount point picked at random, a provider's
reading relabelled by the other provider's logic -- plus the failure paths,
which are worth more than the happy path because they are the ones nobody sees
until the day they matter.
"""
from __future__ import annotations

import json
import pathlib
import sqlite3
import sys
import tempfile
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app import aws as A                                    # noqa: E402
from app.main import fleet_summary, live_branches, prefer_probe_util   # noqa: E402
from app.store import Store                                 # noqa: E402

INSTANCE = {
    "InstanceId": "i-0abc123def456789a", "InstanceType": "g6.12xlarge",
    "State": {"Name": "running"}, "Placement": {"AvailabilityZone": "us-east-1d"},
    "InstanceLifecycle": "spot", "LaunchTime": "2026-09-23T10:00:00+00:00",
    "ImageId": "ami-0deadbeef", "CpuOptions": {"CoreCount": 24},
    "Tags": [{"Key": "project", "Value": "egto"}, {"Key": "owner", "Value": "AustinM"},
             {"Key": "repo_ref", "Value": "b7a5a323d158967cc34269665d54b9982c80962e"},
             {"Key": "Name", "Value": "egto-AustinM"},
             {"Key": "agent", "Value": "Opus-Benchmarking"}],
}
VALUES = {
    "nvidia_smi_utilization_gpu": 93.0, "nvidia_smi_memory_used": 9000.0,
    "nvidia_smi_memory_total": 23028.0, "mem_used_percent": 44.5,
    "disk_used_percent": 12.5, "CPUUtilization": 31.0,
    "NetworkIn": 3000.0, "NetworkOut": 600.0,
}


def fake_aws(args, timeout=45):
    op = f"{args[0]} {args[1]}"
    if op == "ec2 describe-instances":
        return {"Reservations": [{"Instances": [INSTANCE]}]}
    if op == "ec2 describe-spot-price-history":
        return {"SpotPriceHistory": [{"SpotPrice": "1.3021"}]}
    if op == "cloudwatch list-metrics":
        dim = [{"Name": "InstanceId", "Value": INSTANCE["InstanceId"]}]
        metrics = [
            {"MetricName": name, "Dimensions": dim + [{"Name": "index", "Value": str(i)}]}
            for i in range(4)
            for name in ("nvidia_smi_utilization_gpu", "nvidia_smi_memory_used",
                         "nvidia_smi_memory_total")
        ]
        metrics.append({"MetricName": "mem_used_percent", "Dimensions": dim})
        # Two mount points: only the root filesystem is the box's "disk full?".
        metrics.append({"MetricName": "disk_used_percent",
                        "Dimensions": dim + [{"Name": "path", "Value": "/"}]})
        metrics.append({"MetricName": "disk_used_percent",
                        "Dimensions": dim + [{"Name": "path", "Value": "/mnt"}]})
        return {"Metrics": metrics}
    if op == "cloudwatch get-metric-data":
        queries = json.loads(args[args.index("--metric-data-queries") + 1])
        stamp = time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(time.time() - 42))
        return {"MetricDataResults": [
            {"Id": q["Id"], "Values": [VALUES[q["MetricStat"]["Metric"]["MetricName"]]],
             "Timestamps": [stamp]}
            for q in queries
        ]}
    raise AssertionError(f"unexpected AWS call: {op}")


def check(label: str, got, want) -> None:
    assert got == want, f"{label}: got {got!r}, want {want!r}"
    print(f"  ok  {label} = {got!r}")


def main() -> int:
    A._aws = fake_aws
    records, error = A.AwsClient().fetch()
    assert error is None, error
    r = records[0]

    print("record")
    check("id", r["id"], "i-0abc123def456789a")
    check("provider", r["provider"], "ec2")
    # `agent` beats Name ("egto-AustinM" would collapse one person's whole fleet
    # into a single band) and beats a 40-char sha.
    check("label", r["label"], "Opus-Benchmarking")
    check("short_ref", r["short_ref"], "b7a5a323d158")
    # The card count comes from CloudWatch, not the instance-type table.
    check("num_gpus", r["num_gpus"], 4)
    check("gpu_util", r["gpu_util"], 93.0)
    check("gpu_util_src", r["gpu_util_src"], "cwagent")
    # NetworkIn is BYTES PER 300s PERIOD. Read raw it is 300x the true rate.
    check("net_recv_bps", r["net_recv_bps"], 10.0)
    check("net_sent_bps", r["net_sent_bps"], 2.0)
    # "/" not "/mnt": the disk plugin publishes one series per mount.
    check("disk_percent", r["disk_percent"], 12.5)
    check("cpu_util", r["cpu_util"], 31.0)
    check("dph_total", r["dph_total"], 1.3021)
    check("dph_estimated", r["dph_estimated"], True)
    # Not published by the agent on these boxes: a gap, never a zero.
    check("gpu_temp_c", r["gpu_temp_c"], None)
    age = r["gpu_probe"]["age_s"]
    assert age is not None and 30 < age < 120, age
    print(f"  ok  gpu_probe.age_s = {age:.0f}s from the datapoint's own timestamp")

    print("provider isolation")
    vast = {"id": 51792346, "provider": "vast", "gpu_util": 20.0, "gpus": [], "gpu_probe": {}}
    before = (r["gpu_util"], r["gpu_util_src"])
    prefer_probe_util([r, vast])
    check("ec2 reading untouched by the Vast probe logic", (r["gpu_util"], r["gpu_util_src"]), before)
    check("vast record still labelled", vast["gpu_util_src"], "api")

    print("failure paths")
    c = A.AwsClient()
    c._read_metrics = lambda ids: (_ for _ in ()).throw(A.AwsError("(Throttling) GetMetricData"))
    degraded, err = c.fetch()
    check("a CloudWatch outage still reports the box", len(degraded), 1)
    check("and blames CloudWatch, not the box's agent",
          "Throttling" in (degraded[0]["gpu_probe"]["error"] or ""), True)
    check("fleet listing error is separate", err, None)
    for message, want in [
        ("An error occurred (ExpiredToken) when calling DescribeInstances", "SSO session expired"),
        ("Error loading SSO Token: Token has expired and refresh failed", "SSO session expired"),
        ("Unable to locate credentials.", "no AWS credentials"),
        ("An error occurred (UnauthorizedOperation)", "access denied"),
    ]:
        got = A.explain(A.AwsError(message))
        assert want in got, f"explain({message[:30]!r}) -> {got!r}"
        print(f"  ok  {want!r} -> {got!r}")

    print("mixed fleet")
    vast.update(is_running=True, num_gpus=4, label="in1k", dph_total=2.11, cpu_util=9.0,
                vram_used_gb=3.7, vram_total_gb=95.9, ram_used_gb=28.0, ram_total_gb=268.0,
                disk_used_gb=40.0, disk_total_gb=500.0, net_recv_bps=1.0, net_sent_bps=1.0,
                start_date=time.time() - 3600, gpu_temp_c=40.0)
    fleet = fleet_summary([r, vast])
    check("gpus across both clouds", fleet["gpus"], 8)
    check("dph across both clouds", round(fleet["dph_total"], 4), 3.4121)
    # Would be a TypeError the moment one branch held boxes from both providers.
    rails = live_branches([r, vast])
    check("branch ids sort across id types", sorted(b["branch"] for b in rails),
          ["Opus-Benchmarking", "in1k"])

    print("store")
    db = pathlib.Path(tempfile.mkdtemp()) / "t.db"
    store = Store(db)
    now = time.time()
    store.write(now, [r, vast])
    store.write_gpus(now, [r, vast])
    store.close()
    con = sqlite3.connect(db)
    kinds = dict(con.execute("SELECT id, typeof(id) FROM instances"))
    # INTEGER PRIMARY KEY is the rowid alias and would reject the EC2 id
    # outright, taking the whole poll's write with it.
    check("both id types stored", sorted(kinds.values()), ["integer", "text"])
    check("per-GPU rows written for the EC2 box",
          con.execute("SELECT COUNT(*) FROM gpu_samples WHERE instance_id = ?",
                      (r["id"],)).fetchone()[0], 4)

    print("\nALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
