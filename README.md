# vast-compute-monitor

A live dashboard for the GPU instances you have rented on [Vast.ai](https://vast.ai)
— CPU and GPU utilization for every instance, **over time**, in a browser tab.

Same visual language and the same architecture as its sibling
[`dev-server-dashboard-allen`](../dev-server-dashboard-allen), so the two read as
one family of tools. The difference is where the numbers come from: that one
samples local hardware at 1 Hz, this one polls a rate-limited third-party API
every 30s and keeps the history on disk.

```
┌─ this machine ─────────────────────────────────┐        ┌─ Vast.ai ────────┐
│  systemd --user: vast-compute-monitor          │ HTTPS  │  /api/v0/        │
│    ├── poller  ──── every 30s ─────────────────┼───────▶│    instances/    │
│    ├── SQLite  state/vast-metrics.db (30d)     │        └──────────────────┘
│    └── uvicorn :9597  → UI + /ws + /api        │
└───────────────────┬────────────────────────────┘
                    │ browser → http://andrews-ux1:9597  (Tailscale/LAN)
                    ▼ React app ⇄ WebSocket, live snapshots + HTTP history
```

The service only needs outbound HTTPS, so it can run anywhere — it does **not**
have to be near the GPUs it watches.

## What it shows

- **GPU and CPU utilization over time**, all instances on one pair of charts,
  with a selectable window (15m / 1h / 6h / 24h / 7d), crosshair tooltip, legend
  and direct end-labels.
- **Per-instance cards** — GPU compute and VRAM dials, temperature, CPU, RAM and
  disk, utilization sparklines, cost, uptime, location, SSH endpoint and image.
- **Fleet roll-up** — average GPU/CPU utilization, aggregate VRAM, throughput.
- **Spend** — $/hour, day, week and 30 days, plus **idle spend**: what you are
  paying per hour for GPUs that reported under 5% utilization. That number is
  the reason this dashboard exists.
- **A sortable table** of every rented instance, which doubles as the
  no-hover/accessible view of everything the charts plot.

## Install (systemd user service)

```bash
scripts/install-service.sh          # enable + start, serves on :9597
scripts/uninstall-service.sh        # stop + remove (history in state/ is kept)
```

It comes up at boot and survives logout because `localuser` has `Linger=yes`.
Ports in use across these tools: **9595** dev-server dashboard, **9596** health
dashboard, **9597** this one.

```bash
systemctl --user status vast-compute-monitor
systemctl --user restart vast-compute-monitor
tail -f state/vast-compute-monitor.log
```

Overrides (set before `install-service.sh`, they are baked into the unit):
`VASTMON_PORT`, `VASTMON_HOST`, `VASTMON_INTERVAL`, `VASTMON_RETENTION_DAYS`,
`VASTMON_UNIT`.

## Credentials

The API key is read from `VAST_API_KEY`, else `~/.config/vastai/vast_api_key` —
the file the `vastai` CLI already writes, so a logged-in machine needs no setup.
The key never leaves the backend; `/api/info` exposes only its last six
characters, as a fingerprint. Nothing secret is committed.

## Development

```bash
backend/run.sh                      # backend alone on :9597
npm --prefix frontend install
npm --prefix frontend run dev       # Vite on :5173, proxies /api and /ws
npm --prefix frontend run build     # rebuild frontend/dist (committed)
```

`frontend/dist/` is committed on purpose so the service can serve the UI from a
plain clone without Node installed. Rebuild it after any UI edit.

## Things the Vast API does that this code works around

These were measured against the live API, not read from documentation — the
fields involved are undocumented.

**GPU telemetry arrives intermittently, and reports as zeros rather than nulls.**
Instance `50079779` was observed alternating `(gpu_util 66.99, gpu_temp 44.5)` →
`(gpu_util 0.0, gpu_temp 0.0)` on consecutive 30s polls while running a steady
workload. The two zeros always co-occur, and 0 °C is not a temperature a powered
GPU reports, so `gpu_temp == 0` is treated as "the host skipped this report" and
both fields become null. Taking those zeros at face value would have halved every
utilization average on the charts. A genuinely idle GPU that *is* reporting looks
different — steady `gpu_util 0.0` with a real temperature — and charts as a true
zero. Charts draw a gap for a null; instance cards hold the last real reading and
label it with its age.

**`inet_down_billed` / `inet_up_billed` are in kilobytes.** Determined by
measurement: one instance's counter advanced 1,782,579 units in ~380s. Read as
megabytes that is 4.7 GB/s on a 1027 Mbps link — impossible. Read as kilobytes it
is 37 Mbps, which fits. These counters are cumulative, so live throughput is
derived by differencing them between polls; a negative delta (the instance was
recreated and the counter restarted) reports as "no reading" rather than a fake
zero or a huge negative.

**The rate-limit headers are advisory.** The endpoint advertises
`x-ratelimit-limit: 3.0` with `remaining: 0` even on a first request, and five
rapid requests all returned 200. The 30s default poll is chosen to sit inside the
advertised budget anyway; failures back off exponentially to 120s and the UI
shows the last good data with a "stale" banner rather than blanking.

## Why SQLite rather than a ring buffer

The sibling dashboard keeps ~5 minutes in RAM, which is right for a box you are
watching right now. Rented instances run for days, and the question worth asking
is "was this thing busy overnight?" — so samples go to `state/vast-metrics.db`
(30-day retention, pruned hourly) and survive restarts and reboots. Downsampling
is a bucketed `AVG` in SQL, so a 7-day chart costs the same to draw as a
15-minute one. Buckets with no sample are omitted rather than interpolated, so a
period when the poller was down shows as a gap instead of a confident straight
line through hours nothing was recorded.

## Chart colors

The per-instance series palette is fixed, assigned on first sighting and never
recycled, so destroying one instance never repaints the others' lines. It was
validated with the `dataviz` skill's `validate_palette.js` against this app's
panel surface (`#161b22`): chroma floor, CVD separation (worst adjacent ΔE 18.3
deutan / 12.2 tritan), normal-vision separation and ≥3:1 contrast all pass. The
reference lightness band is deliberately not met — it sits below GitHub-dark's
chart ramps, and band-compliant colors measure ~2.6:1 on this surface, too dim to
read at a glance. Identity is never carried by color alone: every chart has a
legend, direct end-labels, and the table view.

Utilization of rented compute uses an **inverted** color scale — green when high,
red when low — because a GPU pinned at 99% is what you are paying for and one at
3% is money leaking. VRAM, RAM and disk keep the normal scale, where full is the
thing to worry about.
