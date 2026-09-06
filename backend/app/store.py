"""SQLite time-series store for Vast instance telemetry.

Why a database instead of the in-RAM ring buffer the Allen dashboard uses: Vast
instances are rented for days or weeks, and the question you actually want
answered is "was this box busy last night?", not "what did it do in the last
five minutes". A restart of this service -- or of the laptop -- must not erase
that. SQLite is the right size of tool here: one file, no daemon, no dependency,
and it handles the one query that matters (bucketed downsample over a window)
in the engine rather than in Python.

Concurrency: one connection shared under a lock. Writes come from the poller
thread, reads from FastAPI request handlers. WAL mode keeps readers from
blocking the writer.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path

# Columns sampled every poll. Kept deliberately narrow -- these are the series
# worth charting; the wide descriptive fields (image, ssh host, cpu model) go in
# the `instances` metadata table where they are written once, not per tick.
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
"""


class Store:
    def __init__(self, path: Path, retention_days: float = 30.0) -> None:
        self.path = path
        self.retention_s = retention_days * 86400.0
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(str(path), check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        # NORMAL is the right durability point for telemetry: it survives a
        # process crash, and the worst case for an OS-level crash is losing the
        # last poll or two of a metric we resample continuously anyway.
        self._db.execute("PRAGMA synchronous=NORMAL")
        self._db.executescript(SCHEMA)
        self._db.commit()
        self._last_prune = 0.0

    def close(self) -> None:
        with self._lock:
            self._db.close()

    # ---------------------------------------------------------------- writes

    def write(self, ts: float, records: list[dict]) -> None:
        """Append one sample row per instance, and upsert its metadata."""
        cols = ("ts", "instance_id", "is_running", *SERIES_COLUMNS)
        placeholders = ", ".join("?" for _ in cols)
        rows = [
            (ts, r["id"], 1 if r["is_running"] else 0, *(r.get(c) for c in SERIES_COLUMNS))
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

    def _maybe_prune(self, now: float) -> None:
        """Drop samples past the retention window, at most once an hour."""
        if now - self._last_prune < 3600.0:
            return
        self._last_prune = now
        cutoff = now - self.retention_s
        with self._lock:
            self._db.execute("DELETE FROM samples WHERE ts < ?", (cutoff,))
            self._db.commit()

    # ----------------------------------------------------------------- reads

    def history(self, minutes: float, buckets: int) -> dict:
        """Downsampled per-instance series over the last `minutes`.

        Averaging inside fixed-width time buckets is done by SQLite so a 7-day
        window costs the same to render as a 15-minute one. Buckets with no
        sample simply do not appear -- the client draws gaps rather than
        inventing a value across a period when the poller was down, which is
        exactly the distinction you want when reading a utilization chart.
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

    def known_instances(self, since: float | None = None) -> list[dict]:
        """Last-known metadata for every instance ever seen (optionally recent).

        Used to keep an instance you destroyed this morning visible in the
        history charts instead of having its line vanish with no explanation.
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
                # A metadata blob that fails to parse (only reachable if the DB
                # file was hand-edited or truncated mid-write) costs the labels
                # for one instance. Its numeric history is in a different table
                # and stays chartable, so degrading this row to an empty label
                # set beats refusing to serve any history at all.
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
