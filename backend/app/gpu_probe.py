"""Per-GPU telemetry, collected by running `nvidia-smi` on each instance.

Why this module has to exist: Vast's API reports ONE number per instance for
GPU utilization, temperature and VRAM, no matter how many GPUs the instance
has. It is an average, and averages hide exactly the thing worth seeing. A
2x4090 instance was measured reporting `gpu_util = 49.5` while the truth was:

    GPU 0   util 99%   2158/24564 MB   44 C   220.7 W
    GPU 1   util  0%       4/24564 MB   22 C    21.8 W

One card pinned, one card idle, on a machine billed for both. No endpoint on
the API exposes that split -- `/instances/{id}/` returns the same scalars, and
`/instances/{id}/gpus` is a 404 -- so the only honest source is the box itself.

Design notes:

  * SSH connections are multiplexed (ControlMaster/ControlPersist). The first
    probe of an instance pays the full handshake; subsequent ones reuse the
    socket and cost roughly a round trip, which is what makes a 30s cadence
    across a whole fleet affordable.
  * Probing runs in its own thread pool on its own cadence, and the poll loop
    reads the cache. SSH latency therefore never delays the API snapshot: a box
    that has gone unreachable slows nothing but itself.
  * Failures are per-instance and backed off. An instance that is still booting
    refuses SSH for a while, and that is normal, not an error worth retrying
    every tick forever.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

ENABLED = os.environ.get("VASTMON_SSH_PROBE", "1") not in ("0", "false", "no")
SSH_USER = os.environ.get("VASTMON_SSH_USER", "root")


def _discover_keys() -> list[str]:
    """Every candidate private key, most-recently-modified first.

    Multiple keys are offered because Vast bakes the account's registered key
    into an instance at CREATION time, so a fleet built over several days does
    not share one key. Measured: instances created yesterday accept
    ~/.ssh/id_ed25519 and refuse ~/.ssh/id_macbook, while instances created
    today do the exact opposite. Pinning a single key leaves half the fleet
    reporting "Permission denied" and silently losing its per-GPU detail.

    VASTMON_SSH_KEY overrides with a comma-separated list, in order.
    """
    override = os.environ.get("VASTMON_SSH_KEY", "").strip()
    if override:
        return [os.path.expanduser(k.strip()) for k in override.split(",") if k.strip()]

    ssh_dir = os.path.expanduser("~/.ssh")
    if not os.path.isdir(ssh_dir):
        return []
    found = []
    for name in os.listdir(ssh_dir):
        if not name.startswith("id_") or name.endswith(".pub"):
            continue
        path = os.path.join(ssh_dir, name)
        if os.path.isfile(path):
            found.append(path)
    # Newest first: a key added recently is the one most likely to match the
    # instances created recently. Capped because sshd's MaxAuthTries (6 by
    # default) will drop the connection if we offer more identities than that.
    found.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    return found[:4]


SSH_KEYS = _discover_keys()
PROBE_TIMEOUT = float(os.environ.get("VASTMON_PROBE_TIMEOUT", "12"))
PROBE_WORKERS = int(os.environ.get("VASTMON_PROBE_WORKERS", "8"))
# Connections are held open this long between probes, so a steady cadence keeps
# reusing one session rather than re-authenticating every time.
CONTROL_PERSIST = os.environ.get("VASTMON_PROBE_PERSIST", "180")

QUERY_FIELDS = (
    "index",
    "name",
    "utilization.gpu",
    "utilization.memory",
    "memory.used",
    "memory.total",
    "temperature.gpu",
    "power.draw",
    "clocks.sm",
)

MAX_BACKOFF = 600.0


def _num(tok: str) -> float | None:
    tok = tok.strip()
    if not tok or tok in ("[N/A]", "N/A", "[Not Supported]", "Not Supported"):
        return None
    try:
        return float(tok)
    except ValueError:
        # JUSTIFICATION FOR NO FAIL-FAST:
        # nvidia-smi prints driver-dependent placeholders for fields a
        # particular card or container cannot report (power on some vGPU
        # setups, clocks under MIG). One unreadable column must render as a
        # blank cell, not discard the other GPUs' readings for that instance.
        return None


@dataclass
class _State:
    """Per-instance probe bookkeeping."""

    gpus: list[dict] = field(default_factory=list)
    ts: float = 0.0
    error: str | None = None
    failures: int = 0
    next_attempt: float = 0.0


class GpuProbe:
    def __init__(self) -> None:
        self._state: dict[int, _State] = {}
        self._lock = threading.Lock()
        self._pool = ThreadPoolExecutor(max_workers=PROBE_WORKERS, thread_name_prefix="gpuprobe")
        # Control sockets live in a private temp dir so they are cleaned up with
        # the process and cannot collide with another user's.
        self._ctl_dir = tempfile.mkdtemp(prefix="vastmon-ssh-")
        self._ssh = shutil.which("ssh")

    def close(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)
        shutil.rmtree(self._ctl_dir, ignore_errors=True)

    @property
    def available(self) -> bool:
        return ENABLED and self._ssh is not None and bool(SSH_KEYS)

    def unavailable_reason(self) -> str | None:
        if not ENABLED:
            return "per-GPU probe disabled (VASTMON_SSH_PROBE=0)"
        if self._ssh is None:
            return "ssh not found on PATH"
        if not SSH_KEYS:
            return "no ssh private keys found in ~/.ssh (set VASTMON_SSH_KEY)"
        return None

    @property
    def keys(self) -> list[str]:
        return list(SSH_KEYS)

    def _cmd(self, host: str, port: int) -> list[str]:
        assert self._ssh is not None
        keys: list[str] = []
        for k in SSH_KEYS:
            keys += ["-i", k]
        return [
            self._ssh,
            "-p", str(port),
            "-o", "BatchMode=yes",
            # IdentitiesOnly keeps ssh to exactly the keys listed here, so an
            # agent full of unrelated identities cannot exhaust MaxAuthTries
            # before our candidates are offered.
            "-o", "IdentitiesOnly=yes",
            *keys,
            "-o", "StrictHostKeyChecking=accept-new",
            f"-o", f"ConnectTimeout={int(PROBE_TIMEOUT)}",
            # Multiplexing: the expensive part of an SSH probe is the handshake,
            # not the command. Reusing the session is what makes this cheap
            # enough to run against every instance on every tick.
            "-o", "ControlMaster=auto",
            "-o", f"ControlPath={self._ctl_dir}/%r@%h:%p",
            "-o", f"ControlPersist={CONTROL_PERSIST}",
            f"{SSH_USER}@{host}",
            f"nvidia-smi --query-gpu={','.join(QUERY_FIELDS)} --format=csv,noheader,nounits",
        ]

    def _probe_one(self, inst_id: int, host: str, port: int) -> None:
        try:
            proc = subprocess.run(
                self._cmd(host, port),
                capture_output=True,
                text=True,
                timeout=PROBE_TIMEOUT + 5,
            )
        except (subprocess.TimeoutExpired, OSError) as exc:
            self._record_failure(inst_id, f"{type(exc).__name__}: {exc}")
            return

        if proc.returncode != 0:
            msg = (proc.stderr or "").strip().splitlines()
            self._record_failure(inst_id, msg[-1] if msg else f"ssh exit {proc.returncode}")
            return

        gpus: list[dict] = []
        for line in proc.stdout.strip().splitlines():
            parts = line.split(",")
            if len(parts) < len(QUERY_FIELDS):
                # JUSTIFICATION FOR NO FAIL-FAST:
                # The instance's MOTD ("Welcome to vast.ai...") is printed on
                # some hosts before command output. Skipping lines that are not
                # CSV rows is how the real rows get through; failing here would
                # mean no per-GPU data at all on those hosts.
                continue
            idx = _num(parts[0])
            if idx is None:
                continue
            used = _num(parts[4])
            total = _num(parts[5])
            gpus.append(
                {
                    "index": int(idx),
                    "name": parts[1].strip(),
                    "util": _num(parts[2]),
                    "mem_util": _num(parts[3]),
                    "mem_used_mb": used,
                    "mem_total_mb": total,
                    "mem_percent": (100.0 * used / total) if used is not None and total else None,
                    "temp_c": _num(parts[6]),
                    "power_w": _num(parts[7]),
                    "sm_clock_mhz": _num(parts[8]),
                }
            )

        if not gpus:
            self._record_failure(inst_id, "nvidia-smi returned no GPU rows")
            return

        gpus.sort(key=lambda g: g["index"])
        with self._lock:
            st = self._state.setdefault(inst_id, _State())
            st.gpus = gpus
            st.ts = time.time()
            st.error = None
            st.failures = 0
            st.next_attempt = 0.0

    def _record_failure(self, inst_id: int, message: str) -> None:
        """Back off a failing instance, keeping any last-good reading.

        An instance that is still booting refuses SSH for a minute or two, which
        is expected rather than exceptional. The previous readings are retained
        and served with their age so the UI can show them as stale instead of
        blanking a card that was fine ten seconds ago.
        """
        with self._lock:
            st = self._state.setdefault(inst_id, _State())
            st.failures += 1
            st.error = message
            st.next_attempt = time.time() + min(MAX_BACKOFF, 15.0 * (2 ** min(st.failures - 1, 5)))

    def probe(self, instances: list[dict]) -> None:
        """Fire probes for every running instance whose backoff has elapsed.

        Returns immediately: results land in the cache and are picked up by the
        next call to `merge`. Nothing here blocks the API poll loop.
        """
        if not self.available:
            return
        now = time.time()
        live = set()
        for inst in instances:
            if not inst.get("is_running"):
                continue
            host, port = inst.get("ssh_host"), inst.get("ssh_port")
            if not host or not port:
                # JUSTIFICATION FOR NO FAIL-FAST:
                # An instance still being created has no SSH endpoint yet. It is
                # simply not probeable this tick; the next one will pick it up.
                continue
            inst_id = int(inst["id"])
            live.add(inst_id)
            with self._lock:
                st = self._state.get(inst_id)
                if st is not None and now < st.next_attempt:
                    continue
            self._pool.submit(self._probe_one, inst_id, host, int(port))

        # Forget instances that are gone, so a recycled id starts clean.
        with self._lock:
            for gone in set(self._state) - live:
                del self._state[gone]

    def merge(self, instances: list[dict]) -> None:
        """Attach the cached per-GPU readings to each instance record."""
        reason = self.unavailable_reason()
        now = time.time()
        with self._lock:
            for inst in instances:
                st = self._state.get(int(inst["id"]))
                if st is None or not st.gpus:
                    inst["gpus"] = []
                    inst["gpu_probe"] = {
                        "ok": False,
                        "error": reason or (st.error if st else None),
                        "age_s": None,
                    }
                    continue
                inst["gpus"] = st.gpus
                inst["gpu_probe"] = {
                    "ok": st.error is None,
                    "error": st.error,
                    "age_s": now - st.ts,
                }

    def snapshot(self) -> dict[int, list[dict]]:
        with self._lock:
            return {i: list(s.gpus) for i, s in self._state.items() if s.gpus}
