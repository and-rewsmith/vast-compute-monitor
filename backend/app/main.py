"""FastAPI app: polls the Vast.ai API, persists telemetry, and streams it live.

Shape mirrors the Allen dev-server dashboard -- one background sampler, one hub
broadcasting to every connected tab, the built frontend served from the same
port so the websocket is always same-origin. Two things differ, both forced by
the data source:

  * The sampler polls a rate-limited third-party HTTP API rather than local
    hardware, so the interval is seconds-to-minutes, not 1 Hz, and an upstream
    failure has to degrade to "stale" instead of killing the stream.
  * History lives in SQLite and is served over HTTP (not seeded down the
    websocket), because the client can ask for windows up to a week -- far more
    than is sane to push on every reconnect.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .gpu_probe import GpuProbe
from .store import UNLABELED, Store
from .vast import VastClient, load_api_key

REPO_ROOT = Path(__file__).resolve().parents[2]

# Vast's instances endpoint advertises a ~3 requests/minute budget in its
# x-ratelimit headers. 20s (3/min) sits exactly at that budget; the default is
# deliberately a touch slower so a manual refresh or a second dashboard instance
# does not push us over. Host telemetry upstream only refreshes on the order of
# tens of seconds anyway, so polling faster mostly buys duplicate readings.
POLL_INTERVAL = float(os.environ.get("VASTMON_INTERVAL", "30"))
STATE_DIR = Path(os.environ.get("VASTMON_STATE", REPO_ROOT / "state"))
DB_PATH = Path(os.environ.get("VASTMON_DB", STATE_DIR / "vast-metrics.db"))
RETENTION_DAYS = float(os.environ.get("VASTMON_RETENTION_DAYS", "30"))
STATIC_DIR = Path(os.environ.get("VASTMON_STATIC", REPO_ROOT / "frontend/dist"))

# Backoff applied on consecutive upstream failures, capped so a long outage
# still retries a couple of times a minute once Vast comes back.
MAX_BACKOFF = 120.0

# A per-GPU probe reading older than this is not trusted over Vast's own
# figure. The probe retains its last good reading while an instance refuses
# SSH, which is right for display, but a card's utilization from five minutes
# ago should not overrule a current number from anywhere.
PROBE_FRESH_S = float(os.environ.get("VASTMON_PROBE_FRESH_S", "120"))

# How long the first poll after startup waits for the per-GPU probe to warm up
# before writing. Bounded so an unreachable fleet cannot stall startup.
PROBE_WARMUP_S = float(os.environ.get("VASTMON_PROBE_WARMUP_S", "20"))

# The account endpoint is polled on every Nth instance poll. Spend moves slowly
# and predictably compared to utilization, so there is no reason to double our
# request rate against a rate-limited API to watch it.
ACCOUNT_EVERY = int(os.environ.get("VASTMON_ACCOUNT_EVERY", "2"))

# Trailing window used to characterise realized burn. Projections are built from
# this, never from the instantaneous sum of dph: that sum is a step function
# which jumps the moment an instance is created or destroyed, and extrapolating
# a week from a value thirty seconds old is extrapolating from noise.
TRAILING_BURN_S = float(os.environ.get("VASTMON_TRAILING_BURN_S", str(3 * 3600)))


def prefer_probe_util(instances: list[dict]) -> None:
    """Make the nvidia-smi probe the authoritative GPU utilization.

    Vast's per-instance `gpu_util` is not reliable enough to drive the charts:
    instance 50537084 reported 0.0% at a plausible 22 C for hours while all four
    of its cards were at 99%, and across the fleet many individual polls were
    off by more than 25 points. Because 22 C looks like a real idle GPU, the
    existing zero-temperature staleness check cannot catch it. The probe reads
    the cards themselves, so wherever it has a fresh reading its mean across the
    instance's cards replaces the API figure -- and every consumer downstream
    (fleet averages, the branch rail, stored history, the charts) inherits it.
    The raw API value is kept as `api_gpu_util` and the source is recorded.
    """
    for inst in instances:
        inst["api_gpu_util"] = inst.get("gpu_util")
        probe = inst.get("gpu_probe") or {}
        age = probe.get("age_s")
        utils = [g["util"] for g in inst.get("gpus") or [] if g.get("util") is not None]
        if utils and age is not None and age <= PROBE_FRESH_S:
            inst["gpu_util"] = sum(utils) / len(utils)
            inst["gpu_util_src"] = "probe"
        else:
            # JUSTIFICATION FOR NO FAIL-FAST:
            # No fresh probe reading is an expected state -- an instance still
            # booting, or one refusing SSH -- not an error. Vast's own figure is
            # the only number available, so it is used and labelled as such.
            inst["gpu_util_src"] = "api"


def fleet_summary(instances: list[dict]) -> dict:
    """Aggregates across the fleet, computed once server-side so every tab and
    the history endpoint agree on the same definitions."""
    running = [i for i in instances if i["is_running"]]

    def _avg(key: str) -> float | None:
        vals = [i[key] for i in running if i.get(key) is not None]
        return sum(vals) / len(vals) if vals else None

    def _sum(key: str, source: list[dict] | None = None) -> float:
        return sum(i[key] or 0.0 for i in (source if source is not None else instances))

    gpus = sum(i["num_gpus"] for i in running)
    return {
        "total": len(instances),
        "running": len(running),
        "gpus": gpus,
        # Cost accrues on rented instances whether or not they are running --
        # a stopped instance still bills storage -- so dph spans all of them.
        "dph_total": _sum("dph_total"),
        "dph_running": _sum("dph_total", running),
        "avg_gpu_util": _avg("gpu_util"),
        "avg_cpu_util": _avg("cpu_util"),
        "vram_used_gb": _sum("vram_used_gb", running),
        "vram_total_gb": _sum("vram_total_gb", running),
        "ram_used_gb": _sum("ram_used_gb", running),
        "ram_total_gb": _sum("ram_total_gb", running),
        "disk_used_gb": _sum("disk_used_gb"),
        "disk_total_gb": _sum("disk_total_gb"),
        "net_recv_bps": _sum("net_recv_bps", running),
        "net_sent_bps": _sum("net_sent_bps", running),
        # "Idle spend": what you are paying per hour for GPUs doing nothing.
        # This is the number the dashboard exists to make impossible to miss.
        "idle_dph": sum(
            (i["dph_total"] or 0.0)
            for i in running
            if (i.get("gpu_util") is not None and i["gpu_util"] < 5.0)
        ),
        "branches": len({branch_of(i) for i in instances}),
    }


def branch_of(inst: dict) -> str:
    """Branch key for an instance. Labels are branch names and are NOT unique --
    several workers routinely share one -- so this is a grouping key, and the
    branch, not the instance, is the unit of display and cost attribution."""
    label = (inst.get("label") or "").strip()
    return label or UNLABELED


def live_branches(instances: list[dict]) -> list[dict]:
    """Roll the current instance list up by branch, for the branch rail."""
    groups: dict[str, list[dict]] = {}
    for i in instances:
        groups.setdefault(branch_of(i), []).append(i)

    out = []
    for name, members in groups.items():
        running = [m for m in members if m["is_running"]]
        # GPU-weighted mean: a 2-GPU worker at 90% beside a 1-GPU worker at 30%
        # is a 70% branch, not a 60% one.
        num = sum((m["gpu_util"] or 0.0) * m["num_gpus"] for m in running if m["gpu_util"] is not None)
        den = sum(m["num_gpus"] for m in running if m["gpu_util"] is not None)
        out.append(
            {
                "branch": name,
                "instances": len(members),
                "running": len(running),
                "gpus": sum(m["num_gpus"] for m in running),
                "dph_total": sum(m["dph_total"] or 0.0 for m in members),
                "gpu_util": (num / den) if den else None,
                "ids": sorted(m["id"] for m in members),
                "started": min((m["start_date"] or 0.0) for m in members) or None,
            }
        )
    out.sort(key=lambda b: (-b["dph_total"], b["branch"]))
    return out


class Hub:
    """Connected websockets plus the latest snapshot."""

    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()
        self.latest: dict | None = None
        self.account: dict | None = None
        self._lock = asyncio.Lock()

    async def add(self, ws: WebSocket) -> None:
        async with self._lock:
            self.clients.add(ws)

    async def remove(self, ws: WebSocket) -> None:
        async with self._lock:
            self.clients.discard(ws)

    async def broadcast(self, payload: dict) -> None:
        self.latest = payload
        text = json.dumps(payload)
        async with self._lock:
            targets = list(self.clients)
        for ws in targets:
            try:
                await ws.send_text(text)
            except Exception:  # noqa: BLE001
                # JUSTIFICATION FOR NO FAIL-FAST:
                # A dead or wedged socket during a fan-out must not stop
                # delivery to the other tabs. It is dropped here and its own
                # disconnect handler cleans up the rest.
                await self.remove(ws)


hub = Hub()
store: Store | None = None
client: VastClient | None = None
probe: GpuProbe | None = None


async def _poll_loop() -> None:
    assert store is not None and client is not None
    failures = 0
    tick = 0
    # Set after the first SUCCESSFUL poll warms the probe; a failed first poll
    # must not skip the warm-up for the life of the process.
    warmed = False
    while True:
        instances, error = await asyncio.to_thread(client.fetch)
        now = time.time()

        # Account/spend counter on a slower cadence than utilization.
        if tick % ACCOUNT_EVERY == 0:
            account, acct_err = await asyncio.to_thread(client.fetch_account)
            if account is not None and account.get("total_spend") is not None:
                await asyncio.to_thread(
                    store.write_account, now, account.get("credit"), account.get("total_spend")
                )
                hub.account = account
            elif acct_err:
                # JUSTIFICATION FOR NO FAIL-FAST:
                # Spend is a secondary signal. If the account endpoint is having
                # a bad minute, utilization must keep flowing; the ledger simply
                # reports the coverage it has and the next tick retries.
                pass
        tick += 1

        if error is None:
            failures = 0
            # Per-GPU telemetry is collected out-of-band over SSH; merge whatever
            # the probe has cached, then kick off the next round. The API
            # snapshot is never delayed by an unreachable box.
            if probe is not None:
                if not warmed:
                    # First successful poll of this process: warm the cache so
                    # it does not fall back to Vast's figure (see probe_sync).
                    await asyncio.to_thread(probe.probe_sync, instances, PROBE_WARMUP_S)
                    warmed = True
                probe.merge(instances)
                prefer_probe_util(instances)
                probe.probe(instances)
            await asyncio.to_thread(store.write, now, instances)
            await asyncio.to_thread(store.write_gpus, now, instances)
            payload = {
                "type": "snapshot",
                "ts": now,
                "instances": instances,
                "fleet": fleet_summary(instances),
                "branches": live_branches(instances),
                "account": hub.account,
                "error": None,
                "interval": POLL_INTERVAL,
            }
        else:
            failures += 1
            # Keep serving the last good instance list, flagged stale, so the
            # dashboard reports "these numbers are from 4 minutes ago" instead
            # of blanking out and losing the reader's place.
            prev = hub.latest or {}
            payload = {
                "type": "snapshot",
                "ts": now,
                "instances": prev.get("instances", []),
                "fleet": prev.get("fleet", fleet_summary([])),
                "branches": prev.get("branches", []),
                "account": hub.account,
                "error": error,
                "stale_since": prev.get("stale_since") or prev.get("ts") or now,
                "interval": POLL_INTERVAL,
            }

        await hub.broadcast(payload)

        delay = POLL_INTERVAL
        if failures:
            delay = min(MAX_BACKOFF, POLL_INTERVAL * (2 ** min(failures - 1, 4)))
        await asyncio.sleep(delay)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global store, client, probe
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    store = Store(DB_PATH, retention_days=RETENTION_DAYS, interval=POLL_INTERVAL)
    # Constructed here rather than lazily so a missing/invalid API key fails the
    # service at startup, loudly, instead of showing an empty dashboard forever.
    client = VastClient()
    probe = GpuProbe()
    task = asyncio.create_task(_poll_loop())
    try:
        yield
    finally:
        task.cancel()
        probe.close()
        client.close()
        store.close()


app = FastAPI(title="vast-compute-monitor", lifespan=lifespan)


@app.get("/healthz")
async def healthz() -> dict:
    return {"ok": True}


@app.get("/api/info")
async def info() -> JSONResponse:
    key = load_api_key()
    return JSONResponse(
        {
            "interval": POLL_INTERVAL,
            # Fingerprint only. The key itself never leaves the backend.
            "api_key_tail": key[-6:],
            "store": store.stats() if store else None,
            "gpu_probe": {
                "available": probe.available if probe else False,
                "reason": probe.unavailable_reason() if probe else "not started",
                "keys": [k.split("/")[-1] for k in probe.keys] if probe else [],
            },
        }
    )


@app.get("/api/instances")
async def instances() -> JSONResponse:
    """Latest snapshot over plain HTTP (the websocket is the live path)."""
    return JSONResponse(hub.latest or {"ts": None, "instances": [], "error": "no sample yet"})


@app.get("/api/history")
async def history(
    minutes: float = Query(60.0, gt=0, le=60 * 24 * 90),
    buckets: int = Query(240, ge=10, le=2000),
) -> JSONResponse:
    assert store is not None
    data = await asyncio.to_thread(store.history, minutes, buckets)
    return JSONResponse(data)


def _trailing_burn(now: float) -> dict:
    """Realized dollars/hour over the trailing window: min, max and mean.

    This is what the remainder of a period is estimated from -- deliberately a
    RANGE rather than a point. The spread is the honest content of the estimate:
    it says "depends whether these boxes stay up", which is the actual
    uncertainty, instead of asserting a single confident number.
    """
    assert store is not None
    window = store.account_spend(now - TRAILING_BURN_S, now)
    rates = [b["burn_hr"] for b in window["burn"]]
    if len(rates) < 3:
        # JUSTIFICATION FOR NO FAIL-FAST:
        # Too few samples is the normal state for the first minutes after a
        # fresh install, not an error. Returning "no estimate" makes the UI omit
        # the projection entirely, which is the correct rendering of not knowing.
        return {"window_s": TRAILING_BURN_S, "samples": len(rates), "lo": None, "hi": None, "mean": None}
    rates.sort()
    # Trim the extremes: a single poll spanning a restart shows up as one wild
    # rate and would otherwise set the whole advertised range.
    trim = len(rates) // 10
    core = rates[trim: len(rates) - trim] or rates
    return {
        "window_s": TRAILING_BURN_S,
        "samples": len(rates),
        "lo": core[0],
        "hi": core[-1],
        "mean": sum(core) / len(core),
    }


@app.get("/api/spend")
async def spend(minutes: float = Query(1440.0, gt=0, le=60 * 24 * 90)) -> JSONResponse:
    """Spend over the requested window: per-branch rates, realized burn, and the
    account-wide totals the two spend charts need."""
    assert store is not None
    now = time.time()

    def _run() -> dict:
        trailing = _trailing_burn(now)
        extent = store.account_extent()
        series = store.branch_history(minutes, 240)
        history = store.account_spend(now - minutes * 60.0, now)
        return {
            "now": now,
            "tracking_since": extent,
            "trailing_burn": trailing,
            # Scoped to the REQUESTED WINDOW, not to a clock period. Reporting
            # "this hour" against a store only minutes old produced a true
            # number under a label implying a full hour -- exactly backwards.
            "window_spent": history["spent"],
            "window_coverage": history["coverage"],
            # Per-branch $/hr over the window -- the attributable estimate.
            "branch_series": series["series"],
            "start": series["start"],
            "end": series["end"],
            "bucket_s": series["bucket_s"],
            # Account-wide realized burn -- ground truth, drawn as one line over
            # the stack. Divergence between the two is itself informative.
            "account_burn": history["burn"],
        }

    return JSONResponse(await asyncio.to_thread(_run))


@app.get("/api/gpu-history")
async def gpu_history(
    minutes: float = Query(60.0, gt=0, le=60 * 24 * 90),
    buckets: int = Query(240, ge=10, le=2000),
) -> JSONResponse:
    """Per-GPU series, keyed "<instance_id>:<gpu_index>"."""
    assert store is not None
    return JSONResponse(await asyncio.to_thread(store.gpu_history, minutes, buckets))


@app.get("/api/branches")
async def branches(minutes: float = Query(1440.0, gt=0, le=60 * 24 * 90)) -> JSONResponse:
    """Branch lifecycle and integrated cost, scoped to the requested window.

    Scoped, not lifetime: the rail is read alongside charts that show the same
    window, and a branch that finished outside it does not belong on the page.
    Costs are therefore in-window costs, and rows carry `truncated` when the
    branch predates the window so the UI can say the figure is partial.
    """
    assert store is not None
    since = time.time() - minutes * 60.0
    rows = await asyncio.to_thread(store.branch_costs, since)
    return JSONResponse({"branches": rows, "since": since, "minutes": minutes})


@app.get("/api/branch-history")
async def branch_history(
    minutes: float = Query(60.0, gt=0, le=60 * 24 * 90),
    buckets: int = Query(240, ge=10, le=2000),
) -> JSONResponse:
    assert store is not None
    return JSONResponse(await asyncio.to_thread(store.branch_history, minutes, buckets))


@app.get("/api/known")
async def known(days: float = Query(7.0, gt=0)) -> JSONResponse:
    """Instances seen in the window, including ones since destroyed."""
    assert store is not None
    since = time.time() - days * 86400.0
    return JSONResponse({"instances": await asyncio.to_thread(store.known_instances, since)})


@app.websocket("/ws")
async def ws_metrics(ws: WebSocket) -> None:
    await ws.accept()
    await hub.add(ws)
    try:
        if hub.latest is not None:
            await ws.send_text(json.dumps(hub.latest))
        while True:
            # No client messages are expected; this detects disconnects.
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await hub.remove(ws)


# Mounted last so /api and /ws win. Absent during pure-backend dev against the
# Vite dev server, which proxies to this process.
if STATIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
