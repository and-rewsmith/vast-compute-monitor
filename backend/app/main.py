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

from .store import Store
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
    }


class Hub:
    """Connected websockets plus the latest snapshot."""

    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()
        self.latest: dict | None = None
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


async def _poll_loop() -> None:
    assert store is not None and client is not None
    failures = 0
    while True:
        instances, error = await asyncio.to_thread(client.fetch)
        now = time.time()

        if error is None:
            failures = 0
            await asyncio.to_thread(store.write, now, instances)
            payload = {
                "type": "snapshot",
                "ts": now,
                "instances": instances,
                "fleet": fleet_summary(instances),
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
    global store, client
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    store = Store(DB_PATH, retention_days=RETENTION_DAYS)
    # Constructed here rather than lazily so a missing/invalid API key fails the
    # service at startup, loudly, instead of showing an empty dashboard forever.
    client = VastClient()
    task = asyncio.create_task(_poll_loop())
    try:
        yield
    finally:
        task.cancel()
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
