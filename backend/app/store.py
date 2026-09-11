"""SQLite time-series store for Vast instance telemetry and account spend.

Why a database instead of an in-RAM ring buffer: Vast instances are rented for
days, and the questions worth answering are "was this branch busy overnight?"
and "what did that experiment cost?" -- neither survives a restart in RAM.
SQLite is the right size of tool: one file, no daemon, and it does the two
queries that matter (bucketed downsample, and cost integration via a window
function) in the engine rather than in Python.

Two independent spend signals are kept, and they are never mixed:

  * `samples.dph_total`  -- the per-instance price, integrated over time. This
    is an ESTIMATE, but it is attributable: it decomposes by branch and by
    instance, which the account counter cannot.
  * `account.total_spend` -- Vast's cumulative lifetime spend counter. This is
    GROUND TRUTH, immune to autobill top-ups (which move `credit` only), but it
    is account-wide and cannot be attributed to a branch.

Concurrency: one connection under a lock. Writes come from the poller thread,
reads from FastAPI request handlers. WAL keeps readers off the writer's back.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path

# Per-tick numeric series. Deliberately narrow -- these are what gets charted.
# Wide descriptive fields live in `instances.meta`, written once per poll rather
# than duplicated into every row.
SERIES_COLUMNS = (
    "gpu_util",
    "cpu_util",
    "gpu_temp_c",
    "vram_used_gb",
    "vram_total_gb",
    "ram_used_gb",
    "ram_total_gb",
    "disk_used_gb",
    "disk_total_gb",
    "net_recv_bps",
    "net_sent_bps",
    "dph_total",
)

# Columns that are not part of the charted series but must be per-sample:
#   label     -- the branch. First-class (not buried in the meta JSON) because
#                everything groups by it, and because it has to stay queryable
#                after the instance is destroyed and its meta row goes stale.
#   num_gpus  -- the weight for averaging utilization across a branch. A 2-GPU
#                worker at 90% and a 1-GPU worker at 30% is not a 60% branch.
#   api_gpu_util / gpu_util_src -- `gpu_util` holds the AUTHORITATIVE reading,
#                which is the per-GPU nvidia-smi probe (mean across the
#                instance's cards) whenever one was fresh, and Vast's own figure
#                otherwise. The raw Vast figure is kept alongside so the two can
#                always be compared, and the source is recorded per row.
EXTRA_COLUMNS = (
    ("label", "TEXT"),
    ("num_gpus", "REAL"),
    ("api_gpu_util", "REAL"),
    ("gpu_util_src", "TEXT"),
)

# A gap longer than this many poll intervals is not charged when integrating
# cost. The poller being down is not evidence the instance was up, and silently
# billing the outage would inflate exactly the number people trust most.
MAX_CHARGE_GAP_INTERVALS = 3.0

UNLABELED = "(unlabeled)"

# Minimum baseline for a realized-burn reading. Vast advances `total_spend` on
# its own schedule, so differencing two adjacent polls aliases badly against it:
# consecutive readings measured $1.30/hr then $2.90/hr while the true rate was a
# steady $2.26/hr. Neither number was wrong, they just straddled the upstream
# update. Rates are therefore measured across at least this much elapsed time,
# which keeps the reading ground truth while making the spread it advertises
# reflect the fleet changing rather than the sampler beating against the API.
MIN_BURN_DT = 300.0

SCHEMA = f"""
CREATE TABLE IF NOT EXISTS samples (
  ts           REAL    NOT NULL,
  instance_id  INTEGER NOT NULL,
  is_running   INTEGER NOT NULL,
  {", ".join(f"{c} REAL" for c in SERIES_COLUMNS)}
);
CREATE INDEX IF NOT EXISTS idx_samples_inst_ts ON samples(instance_id, ts);
CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples(ts);

CREATE TABLE IF NOT EXISTS instances (
  id          INTEGER PRIMARY KEY,
  first_seen  REAL NOT NULL,
  last_seen   REAL NOT NULL,
  meta        TEXT NOT NULL
);

-- Per-GPU telemetry from nvidia-smi over SSH. Separate from `samples` because
-- it has a different grain (one row per GPU, not per instance) and a different
-- source, so it can be missing for an instance whose API telemetry is fine.
CREATE TABLE IF NOT EXISTS gpu_samples (
  ts           REAL    NOT NULL,
  instance_id  INTEGER NOT NULL,
  gpu_index    INTEGER NOT NULL,
  util         REAL,
  mem_used_mb  REAL,
  mem_total_mb REAL,
  temp_c       REAL,
  power_w      REAL
);
CREATE INDEX IF NOT EXISTS idx_gpu_samples ON gpu_samples(instance_id, gpu_index, ts);
CREATE INDEX IF NOT EXISTS idx_gpu_samples_ts ON gpu_samples(ts);
-- Joined on (instance_id, ts) to pair each instance sample with the probe
-- readings taken in the same poll; both are written with the same timestamp.
CREATE INDEX IF NOT EXISTS idx_gpu_samples_inst_ts ON gpu_samples(instance_id, ts);

-- Account-level ground truth, sampled on its own (slower) cadence.
CREATE TABLE IF NOT EXISTS account (
  ts           REAL PRIMARY KEY,
  credit       REAL,
  total_spend  REAL
);
"""


class Store:
    def __init__(self, path: Path, retention_days: float = 30.0, interval: float = 30.0) -> None:
        self.path = path
        self.retention_s = retention_days * 86400.0
        self.interval = interval
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(str(path), check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        # NORMAL is the right durability point for telemetry: it survives a
        # process crash, and an OS-level crash costs at most the last poll of a
        # signal we resample continuously anyway.
        self._db.execute("PRAGMA synchronous=NORMAL")
        self._db.executescript(SCHEMA)
        self._migrate()
        self._db.commit()
        self._last_prune = 0.0

    def _migrate(self) -> None:
        """Add columns introduced after a database was first created.

        Done with ALTER TABLE rather than a version stamp because every change
        so far is additive; existing rows keep NULL for the new column, which is
        the honest value -- we genuinely did not record a branch for samples
        taken before branches were tracked.
        """
        have = {r["name"] for r in self._db.execute("PRAGMA table_info(samples)")}
        for name, decl in EXTRA_COLUMNS:
            if name not in have:
                self._db.execute(f"ALTER TABLE samples ADD COLUMN {name} {decl}")
        self._db.execute("CREATE INDEX IF NOT EXISTS idx_samples_label_ts ON samples(label, ts)")

        # One-time backfill: rows written before the probe became authoritative
        # hold Vast's figure in gpu_util. Vast's per-instance number is not
        # trustworthy -- instance 50537084 reported 0.0% at a plausible 22 C for
        # hours while nvidia-smi showed all four cards at 99%, and every other
        # instance had ticks off by more than 25 points. Where a probe reading
        # was taken in the same poll it replaces the API figure; the original
        # is preserved in api_gpu_util. Keyed on gpu_util_src IS NULL, so it
        # runs once per row and never re-reads a probe value as an API one.
        probe_mean = (
            "(SELECT AVG(g.util) FROM gpu_samples g "
            "WHERE g.instance_id = samples.instance_id AND g.ts = samples.ts)"
        )
        self._db.execute(
            f"""
            UPDATE samples
               SET api_gpu_util = gpu_util,
                   gpu_util_src = CASE WHEN {probe_mean} IS NOT NULL THEN 'probe' ELSE 'api' END,
                   gpu_util     = COALESCE({probe_mean}, gpu_util)
             WHERE gpu_util_src IS NULL
            """
        )

    def close(self) -> None:
        with self._lock:
            self._db.close()

    # ---------------------------------------------------------------- writes

    def write(self, ts: float, records: list[dict]) -> None:
        """Append one sample row per instance, and upsert its metadata."""
        cols = (
            "ts", "instance_id", "is_running", *SERIES_COLUMNS,
            "label", "num_gpus", "api_gpu_util", "gpu_util_src",
        )
        placeholders = ", ".join("?" for _ in cols)
        rows = [
            (
                ts,
                r["id"],
                1 if r["is_running"] else 0,
                *(r.get(c) for c in SERIES_COLUMNS),
                r.get("label"),
                r.get("num_gpus"),
                r.get("api_gpu_util"),
                r.get("gpu_util_src"),
            )
            for r in records
        ]
        with self._lock:
            self._db.executemany(
                f"INSERT INTO samples ({', '.join(cols)}) VALUES ({placeholders})", rows
            )
            for r in records:
                self._db.execute(
                    """
                    INSERT INTO instances (id, first_seen, last_seen, meta)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen,
                                                  meta      = excluded.meta
                    """,
                    (r["id"], ts, ts, json.dumps(r)),
                )
            self._db.commit()
        self._maybe_prune(ts)

    def write_gpus(self, ts: float, records: list[dict]) -> None:
        """Append one row per GPU per instance, for instances the probe reached."""
        rows = []
        for r in records:
            for g in r.get("gpus") or []:
                rows.append(
                    (
                        ts,
                        r["id"],
                        g["index"],
                        g.get("util"),
                        g.get("mem_used_mb"),
                        g.get("mem_total_mb"),
                        g.get("temp_c"),
                        g.get("power_w"),
                    )
                )
        if not rows:
            return
        with self._lock:
            self._db.executemany(
                """INSERT INTO gpu_samples
                   (ts, instance_id, gpu_index, util, mem_used_mb, mem_total_mb, temp_c, power_w)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                rows,
            )
            self._db.commit()

    def gpu_history(self, minutes: float, buckets: int) -> dict:
        """Downsampled per-GPU series, keyed "<instance_id>:<gpu_index>"."""
        now = time.time()
        start = now - minutes * 60.0
        bucket_s = max(1.0, (minutes * 60.0) / max(1, buckets))
        with self._lock:
            rows = self._db.execute(
                """
                SELECT instance_id, gpu_index,
                       CAST((ts - :start) / :bucket AS INTEGER) AS b,
                       MIN(ts) AS ts,
                       AVG(util) AS util,
                       AVG(mem_used_mb) AS mem_used_mb,
                       AVG(mem_total_mb) AS mem_total_mb,
                       AVG(temp_c) AS temp_c,
                       AVG(power_w) AS power_w
                  FROM gpu_samples
                 WHERE ts >= :start
              GROUP BY instance_id, gpu_index, b
              ORDER BY instance_id, gpu_index, b
                """,
                {"start": start, "bucket": bucket_s},
            ).fetchall()

        series: dict[str, list[dict]] = {}
        for r in rows:
            key = f"{r['instance_id']}:{r['gpu_index']}"
            series.setdefault(key, []).append(
                {
                    "ts": r["ts"],
                    "util": r["util"],
                    "mem_used_mb": r["mem_used_mb"],
                    "mem_total_mb": r["mem_total_mb"],
                    "mem_percent": (
                        100.0 * r["mem_used_mb"] / r["mem_total_mb"]
                        if r["mem_used_mb"] is not None and r["mem_total_mb"]
                        else None
                    ),
                    "temp_c": r["temp_c"],
                    "power_w": r["power_w"],
                }
            )
        return {
            "start": start,
            "end": now,
            "minutes": minutes,
            "bucket_s": bucket_s,
            "series": series,
        }

    def write_account(self, ts: float, credit: float | None, total_spend: float | None) -> None:
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO account (ts, credit, total_spend) VALUES (?, ?, ?)",
                (ts, credit, total_spend),
            )
            self._db.commit()

    def _maybe_prune(self, now: float) -> None:
        """Drop samples past the retention window, at most once an hour."""
        if now - self._last_prune < 3600.0:
            return
        self._last_prune = now
        cutoff = now - self.retention_s
        with self._lock:
            self._db.execute("DELETE FROM samples WHERE ts < ?", (cutoff,))
            self._db.execute("DELETE FROM gpu_samples WHERE ts < ?", (cutoff,))
            self._db.execute("DELETE FROM account WHERE ts < ?", (cutoff,))
            self._db.commit()

    # ----------------------------------------------------------- util history

    def history(self, minutes: float, buckets: int) -> dict:
        """Downsampled per-INSTANCE series over the last `minutes`.

        Bucket averaging happens in SQLite, so a 7-day window costs the same to
        render as a 15-minute one. Buckets with no sample are simply absent --
        the client draws a gap rather than interpolating across a period the
        poller never observed.
        """
        now = time.time()
        start = now - minutes * 60.0
        bucket_s = max(1.0, (minutes * 60.0) / max(1, buckets))
        avg_cols = ", ".join(f"AVG({c}) AS {c}" for c in SERIES_COLUMNS)

        with self._lock:
            rows = self._db.execute(
                f"""
                SELECT instance_id,
                       CAST((ts - :start) / :bucket AS INTEGER) AS b,
                       MIN(ts) AS ts,
                       MAX(is_running) AS is_running,
                       {avg_cols}
                  FROM samples
                 WHERE ts >= :start
              GROUP BY instance_id, b
              ORDER BY instance_id, b
                """,
                {"start": start, "bucket": bucket_s},
            ).fetchall()

        series: dict[str, list[dict]] = {}
        for row in rows:
            point = {"ts": row["ts"], "is_running": bool(row["is_running"])}
            for c in SERIES_COLUMNS:
                point[c] = row[c]
            series.setdefault(str(row["instance_id"]), []).append(point)

        return {
            "start": start,
            "end": now,
            "minutes": minutes,
            "bucket_s": bucket_s,
            "series": series,
        }

    def branch_history(self, minutes: float, buckets: int) -> dict:
        """Downsampled per-BRANCH series: utilization weighted by GPU count, and
        the dollars actually accrued inside each bucket.

        A branch is a set of workers, so its utilization is the GPU-weighted
        mean of theirs -- a 2-GPU worker at 90% next to a 1-GPU worker at 30% is
        a 70% branch, not a 60% one. The weighted mean is built in two stages so
        that an instance sampled twice inside one bucket does not count twice:
        average per instance first, then combine across the branch.

        `cost` is integrated HERE, not by the client. The client only has bucket
        midpoints, so it would have to infer the elapsed time between them --
        and across a gap where the branch was not running that inference is
        catastrophically wrong: a branch idle for 601 minutes and resuming at
        $2.681/hr had ~$26.89 of spend invented for hours it did not exist. The
        same capped Riemann sum as `branch_costs` is used, so the chart, the
        rail and the ledger cannot disagree.
        """
        now = time.time()
        start = now - minutes * 60.0
        bucket_s = max(1.0, (minutes * 60.0) / max(1, buckets))
        cap = self.interval * MAX_CHARGE_GAP_INTERVALS

        with self._lock:
            rows = self._db.execute(
                """
                SELECT label,
                       b,
                       MIN(ts) AS ts,
                       COUNT(*) AS instances,
                       SUM(w) AS gpus,
                       SUM(CASE WHEN gpu_util IS NOT NULL THEN gpu_util * w END)
                         / NULLIF(SUM(CASE WHEN gpu_util IS NOT NULL THEN w END), 0) AS gpu_util,
                       SUM(CASE WHEN cpu_util IS NOT NULL THEN cpu_util * w END)
                         / NULLIF(SUM(CASE WHEN cpu_util IS NOT NULL THEN w END), 0) AS cpu_util,
                       SUM(dph) AS dph_total,
                       SUM(cost) AS cost,
                       SUM(vram_used) AS vram_used_gb,
                       SUM(vram_total) AS vram_total_gb
                  FROM (
                        SELECT label,
                               instance_id,
                               b,
                               MIN(ts) AS ts,
                               AVG(gpu_util) AS gpu_util,
                               AVG(cpu_util) AS cpu_util,
                               AVG(dph_total) AS dph,
                               AVG(vram_used_gb) AS vram_used,
                               AVG(vram_total_gb) AS vram_total,
                               COALESCE(MAX(num_gpus), 1) AS w,
                               SUM(COALESCE(dph_total, 0) * MIN(COALESCE(dt, 0), :cap)) / 3600.0 AS cost
                          FROM (
                                SELECT COALESCE(label, :unlabeled) AS label,
                                       instance_id, ts, gpu_util, cpu_util, dph_total,
                                       vram_used_gb, vram_total_gb, num_gpus,
                                       CAST((ts - :start) / :bucket AS INTEGER) AS b,
                                       LEAD(ts) OVER (PARTITION BY instance_id ORDER BY ts) - ts AS dt
                                  FROM samples
                                 WHERE ts >= :start
                               )
                      GROUP BY instance_id, b
                       )
              GROUP BY label, b
              ORDER BY label, b
                """,
                {"start": start, "bucket": bucket_s, "unlabeled": UNLABELED, "cap": cap},
            ).fetchall()

        series: dict[str, list[dict]] = {}
        for row in rows:
            series.setdefault(row["label"], []).append(
                {
                    "ts": row["ts"],
                    "instances": row["instances"],
                    "gpus": row["gpus"],
                    "gpu_util": row["gpu_util"],
                    "cpu_util": row["cpu_util"],
                    "dph_total": row["dph_total"],
                    "cost": row["cost"],
                    # Pooled, not averaged: a branch's VRAM pressure is the
                    # total it is holding over the total it was given, so a
                    # nearly-full worker is not hidden by an empty one.
                    "vram_percent": (
                        100.0 * row["vram_used_gb"] / row["vram_total_gb"]
                        if row["vram_used_gb"] is not None and row["vram_total_gb"]
                        else None
                    ),
                }
            )

        return {
            "start": start,
            "end": now,
            "minutes": minutes,
            "bucket_s": bucket_s,
            "series": series,
        }

    # ------------------------------------------------------------ attribution

    def branch_costs(self, since: float | None = None) -> list[dict]:
        """Per-branch integrated cost and lifecycle, restricted to a window.

        Cost is a Riemann sum over each instance's own samples: price at a
        sample multiplied by the interval to the NEXT sample. The interval is
        capped, so a stretch where the poller was down contributes nothing
        rather than billing hours nobody observed -- undercounting a gap is
        honest, inventing spend through it is not.

        Because the window filters the samples, the cost returned is the cost
        INSIDE the window, not the branch's lifetime total. A branch that was
        already running when the window opened would otherwise show a total that
        silently means something different from the one beside it. So the full
        extent is reported alongside it and the caller can say which is which.
        """
        cap = self.interval * MAX_CHARGE_GAP_INTERVALS
        since_v = since if since is not None else 0.0
        params: dict = {"cap": cap, "unlabeled": UNLABELED, "since": since_v}

        # Full extent, ignoring the window, so a windowed row can be marked as
        # the fragment it is.
        with self._lock:
            extent = {
                r["label"]: (r["first_seen_all"], r["last_seen_all"])
                for r in self._db.execute(
                    """
                    SELECT COALESCE(label, :unlabeled) AS label,
                           MIN(ts) AS first_seen_all,
                           MAX(ts) AS last_seen_all
                      FROM samples
                  GROUP BY COALESCE(label, :unlabeled)
                    """,
                    {"unlabeled": UNLABELED},
                ).fetchall()
            }

        with self._lock:
            rows = self._db.execute(
                """
                SELECT label,
                       MIN(ts)  AS first_seen,
                       MAX(ts)  AS last_seen,
                       COUNT(DISTINCT instance_id) AS instances,
                       SUM(COALESCE(dph_total, 0) * MIN(COALESCE(dt, 0), :cap)) / 3600.0 AS cost,
                       SUM(CASE WHEN gpu_util IS NOT NULL THEN gpu_util * w END)
                         / NULLIF(SUM(CASE WHEN gpu_util IS NOT NULL THEN w END), 0) AS avg_gpu_util
                  FROM (
                        SELECT COALESCE(label, :unlabeled) AS label,
                               instance_id, ts, dph_total, gpu_util,
                               COALESCE(num_gpus, 1) AS w,
                               LEAD(ts) OVER (PARTITION BY instance_id ORDER BY ts) - ts AS dt
                          FROM samples
                         WHERE ts >= :since
                       )
              GROUP BY label
              ORDER BY last_seen DESC
                """,
                params,
            ).fetchall()

        out = []
        for r in rows:
            d = dict(r)
            first_all, last_all = extent.get(d["label"], (d["first_seen"], d["last_seen"]))
            d["first_seen_all"] = first_all
            d["last_seen_all"] = last_all
            # True when the branch was already running before the window opened,
            # so the cost above covers only part of its life.
            d["truncated"] = first_all is not None and first_all < since_v - 1.0
            out.append(d)
        return out

    # ------------------------------------------------------------------ spend

    def account_spend(self, start: float, end: float | None = None) -> dict:
        """Realized spend between two timestamps, from Vast's own counter.

        Differencing `total_spend` gives ground truth. Autobill top-ups do not
        appear here at all (they move `credit`, not this counter), but the guard
        against positive deltas stays: a refund or an upstream correction would
        otherwise be charged as spend.

        `coverage` reports how much of the requested period we actually have
        samples for. A "this week" figure built from four hours of data is a
        fabrication, and the UI needs to be able to say so rather than print a
        confident under-count.
        """
        end = end if end is not None else time.time()
        with self._lock:
            rows = self._db.execute(
                """
                SELECT ts, total_spend,
                       total_spend - LAG(total_spend) OVER (ORDER BY ts) AS d,
                       ts - LAG(ts) OVER (ORDER BY ts) AS dt
                  FROM account
                 WHERE ts >= :start AND ts <= :end AND total_spend IS NOT NULL
              ORDER BY ts
                """,
                {"start": start, "end": end},
            ).fetchall()

        # Total spent uses every delta (exact); the burn SERIES is resampled onto
        # a coarser baseline (accurate, un-aliased). Two different jobs, so two
        # different accumulations over the same rows.
        spent = 0.0
        burn: list[dict] = []
        acc_spend = 0.0
        acc_dt = 0.0
        running = 0.0
        for r in rows:
            if r["d"] is None or r["dt"] is None or r["dt"] <= 0:
                continue
            # total_spend decreases as money is spent, so a NEGATIVE delta is
            # the spend. A positive delta is a correction, not income.
            if r["d"] > 0:
                # JUSTIFICATION FOR NO FAIL-FAST:
                # A refund or upstream correction is a legitimate account event
                # we cannot attribute to a time window. Skipping the interval
                # keeps the spend total from going backwards; failing here would
                # take the dashboard down over a bookkeeping adjustment.
                continue
            spent += -r["d"]
            running += -r["d"]
            acc_spend += -r["d"]
            acc_dt += r["dt"]
            if acc_dt >= MIN_BURN_DT:
                burn.append(
                    {
                        "ts": r["ts"],
                        "burn_hr": (acc_spend / acc_dt) * 3600.0,
                        # Dollars actually charged since the start of the window,
                        # for the cumulative chart's ground-truth line.
                        "cum": running,
                    }
                )
                acc_spend = 0.0
                acc_dt = 0.0

        covered = 0.0
        if rows:
            covered = min(end, rows[-1]["ts"]) - max(start, rows[0]["ts"])
        period = max(1e-9, end - start)
        return {
            "start": start,
            "end": end,
            "spent": spent,
            "burn": burn,
            "coverage": max(0.0, min(1.0, covered / period)),
            "samples": len(rows),
        }

    def account_extent(self) -> float | None:
        """Timestamp of the oldest account sample -- when spend tracking began."""
        with self._lock:
            row = self._db.execute("SELECT MIN(ts) AS t FROM account").fetchone()
        return row["t"] if row and row["t"] is not None else None

    def latest_account(self) -> dict | None:
        with self._lock:
            row = self._db.execute(
                "SELECT ts, credit, total_spend FROM account ORDER BY ts DESC LIMIT 1"
            ).fetchone()
        return dict(row) if row else None

    # ------------------------------------------------------------------ misc

    def known_instances(self, since: float | None = None) -> list[dict]:
        """Last-known metadata for every instance seen (optionally recent).

        Keeps an instance destroyed this morning present in the history charts
        instead of having its line vanish with no explanation.
        """
        sql = "SELECT id, first_seen, last_seen, meta FROM instances"
        params: tuple = ()
        if since is not None:
            sql += " WHERE last_seen >= ?"
            params = (since,)
        with self._lock:
            rows = self._db.execute(sql + " ORDER BY id", params).fetchall()
        out = []
        for row in rows:
            try:
                meta = json.loads(row["meta"])
            except ValueError:
                # JUSTIFICATION FOR NO FAIL-FAST:
                # A metadata blob that fails to parse costs the labels for one
                # instance. Its numeric history lives in a different table and
                # stays chartable, so degrading this row beats refusing to serve
                # any history at all.
                meta = {}
            out.append(
                {
                    "id": row["id"],
                    "first_seen": row["first_seen"],
                    "last_seen": row["last_seen"],
                    "meta": meta,
                }
            )
        return out

    def stats(self) -> dict:
        with self._lock:
            row = self._db.execute(
                "SELECT COUNT(*) AS n, MIN(ts) AS oldest, MAX(ts) AS newest FROM samples"
            ).fetchone()
        size = self.path.stat().st_size if self.path.exists() else 0
        return {
            "samples": row["n"],
            "oldest": row["oldest"],
            "newest": row["newest"],
            "db_bytes": size,
            "db_path": str(self.path),
            "retention_days": self.retention_s / 86400.0,
        }
