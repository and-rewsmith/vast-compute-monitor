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
have to be near the GPUs it watches. Since the EC2 source was added it polls two
providers on that one socket: Vast's API, and AWS EC2 + CloudWatch through the
`aws` CLI. See "The EC2 side" below.

## What it shows

Instances are labelled with the **branch** they are running, and several workers
routinely share one label — so the label is a grouping key, not a name, and the
branch is the unit of display and of cost attribution throughout.

- **Branch rail** — one band per branch: name as the headline, live workers,
  GPU-weighted utilization, and cost to date. Finished branches keep their band
  and their final cost, which is the retrospective the persisted history exists
  for.
- **GPU, VRAM and CPU utilization over time**, one line per branch by default
  (toggle to per-instance), with a selectable window, crosshair tooltip and
  legend. Branch VRAM is pooled — total held over total allotted — so a
  nearly-full worker is not averaged away by an empty one.
- **Spend per hour** — $/hr stacked by branch, with a `now` rule: solid to the
  left, hatched projection wedge to the right. See "Actual versus projected".
- **Cumulative spend** — dollars so far across the window, stacked by branch,
  with what Vast actually charged drawn over it.
- **Per-instance cards**, grouped under their branch, with **one block per
  physical GPU** — its own compute and VRAM dials, its own temperature, power
  and utilization trace. CPU stays instance-level, since it is one pool shared
  by every GPU on the box. Plus cost, uptime, location, SSH and image.
- **A sortable table** of every rented instance, Branch first, which doubles as
  the no-hover/accessible view of everything the charts plot.

Every chart and sparkline follows the window selector, up to **30d** — the same
as the store's retention, so the selector reaches everything that is kept. The
branch rail follows it too: a branch that finished outside the window is not
shown, and the cost on a band is the cost *inside* the window. A branch that was
already running when the window opened is marked "started earlier", so a partial
figure is never read as a lifetime total.

## Per-GPU telemetry, and why it needs SSH

Vast's API reports **one** number per instance for GPU utilization, temperature
and VRAM, however many GPUs the instance has. It is an average, and the average
hides the thing worth seeing. Measured on a live 2×4090 box:

```
API:     gpu_util = 49.5
Reality: GPU 0  util 99%  2158/24564 MB  44°C  220.7 W
         GPU 1  util  0%      4/24564 MB  22°C   21.8 W
```

One card pinned, one card idle, on a machine billed for both. No endpoint
exposes the split — `/instances/{id}/` returns the same scalars and
`/instances/{id}/gpus` is a 404 — so the only honest source is the box itself.
The backend therefore runs `nvidia-smi` on each running instance over SSH.

- **Connections are multiplexed** (`ControlMaster` / `ControlPersist`). The
  first probe pays the handshake; later ones reuse the socket, which is what
  makes a 30s cadence across a fleet affordable.
- **Probing is out-of-band**, in its own thread pool, and the poll loop reads a
  cache. A box that has gone unreachable slows nothing but itself.
- **Failures back off per instance** and keep the last good reading, labelled
  with its age. An instance that is still booting refuses SSH for a minute or
  two; that is normal, not an error to retry forever.
- **When the probe cannot reach an instance**, the card falls back to Vast's
  averaged number and *says so* — labelled "avg of N" rather than dressed up as
  per-GPU detail that was never measured.

**Several keys are offered, not one.** Vast bakes the account's registered key
into an instance at *creation* time, so a fleet built over several days does not
share a key: instances created one day accepted `~/.ssh/id_ed25519` and refused
`~/.ssh/id_macbook`, while instances created the next did exactly the opposite.
The probe therefore offers every private key in `~/.ssh` (newest first, capped
at four so sshd's `MaxAuthTries` cannot drop the connection before the right one
is tried).

Config: `VASTMON_SSH_PROBE=0` disables it entirely; `VASTMON_SSH_KEY` overrides
key discovery with a comma-separated list; `VASTMON_SSH_USER` (default `root`),
`VASTMON_PROBE_TIMEOUT`, `VASTMON_PROBE_WORKERS`, `VASTMON_PROBE_PERSIST`.
`/api/info` reports whether the probe is available, why not, and which keys it
is offering.

**The probe is the authoritative GPU utilization everywhere** — the charts,
the branch rail, the table and stored history all read it, with Vast's figure
used only when no fresh probe reading exists. Vast's number is not trustworthy
enough to drive a chart: instance `50537084` reported **0.0% at a plausible
22°C** for hours while all four of its cards ran at 99%, and because 22°C looks
like a real idle GPU the zero-temperature staleness check could not catch it.
Across the fleet, individual polls were routinely off by more than 25 points.
Vast's raw figure is kept in `api_gpu_util` for comparison, and every stored row
records its source in `gpu_util_src`. The probe is warmed synchronously on the
first poll after startup, so a restart does not write a tick of Vast's figure
into the chart.

## The EC2 side (AWS)

GPU boxes are rented in two places, so the board shows both. The EGTO AWS
account launches every box from one template tagged `project=egto`, so a single
`describe-instances` filtered on that tag is the fleet — the same listing
`egq box ls --fleet` shows. Field-for-field the mapping follows
`box_record_from_instance` in egq's `egq_aws.py`, so the two tools agree on what
a box *is*, and everything downstream (store, websocket, charts, spend) is
provider-agnostic: one normalized record with `provider` saying where it came
from.

Three things differ from Vast and shape `backend/app/aws.py`:

**Telemetry is a second call.** Vast returns live utilization in the same
response as the instance list; EC2 does not. The numbers come from CloudWatch,
published by the CloudWatch agent every 60s in the `CWAgent` namespace,
dimensioned by `InstanceId` and — for the nvidia metrics — by GPU `index`, which
is what makes the per-GPU blocks work here too. Metric *names* are discovered
per box with `list-metrics` rather than assumed, because they depend on the
agent's config. On the current boxes the agent publishes `utilization_gpu`,
`memory_used` and `memory_total`, but **not** temperature or power, so those
dials are blank on an EC2 card — a gap, never a zero. CPU and network come from
`AWS/EC2` itself and so survive a box whose agent is not up yet; `NetworkIn`/
`NetworkOut` are bytes per 300s period and are divided down to a rate.

**These boxes are never SSH-probed.** An EGTO box terminates itself after 30
idle minutes only if *nobody is logged in*, and the per-GPU probe holds an SSH
master connection open (`ControlPersist`). Probing EC2 would quietly keep idle
boxes alive and billing — the exact failure this dashboard exists to expose — so
`gpu_probe.py` is handed only the Vast half of the fleet. The instance id is
still recorded as `ssh_host` for a human to copy (`~/.ssh/config` routes
`Host i-*` through Session Manager); nothing in this process connects.

**There is no long-lived credential, by policy.** The account's deny list blocks
`iam:CreateAccessKey`, so a 24/7 poller cannot hold a key of its own: it rides
the operator's SSO session, which expires daily. That is reported, not hidden —
the banner names the command (`aws sso login --profile me`) and says Vast is
unaffected. While it is expired, EC2 boxes are missing from the board and their
history has a hole; the one machine with a non-expiring identity is `egq-host`
(instance profile), so a collector that must stay correct through a logged-out
night belongs there, with the Mac as a reader.

Cost is per-provider honest. On-demand comes from a small table of us-east-1
prices; spot is the **live** market price for the box's type and zone, which is
what it is billed at — so it drifts, and any cumulative figure built on it is an
estimate. Those records carry `dph_estimated`, and the table marks them `~`. A
stopped box's EBS cost is not counted (boxes terminate rather than stop, so this
is rare). Polling is billed too: `GetMetricData` is charged per metric, so only
running boxes are read, only the metrics above, at most once a minute.

Environment: `VASTMON_AWS=0` disables the source entirely, `VASTMON_AWS_PROFILE`
(default `me`) and `VASTMON_AWS_REGION` select the account, `VASTMON_AWS_EVERY`
sets how many Vast polls pass between EC2 polls (default 2), and
`VASTMON_AWS_LABEL_TAG` forces one tag as the branch key instead of the default
order (`agent`, then `Name`, then a shortened `repo_ref`).

## Actual versus projected

Two independent spend signals are tracked, and they are never mixed:

| Signal | Source | Accuracy | Decomposable |
|---|---|---|---|
| Realized burn | `users/current.total_spend` deltas | Ground truth | No — account-wide |
| Attributed spend | `dph_total` integrated over time | Estimate | Yes — per branch |

`total_spend` is a cumulative lifetime counter and is the right one to difference:
unlike `credit` it is untouched by autobill top-ups, which raise the balance
without being spend. Both were measured moving by identical deltas while
running, with only `credit` jumping on a top-up.

Rates are measured across a **300s minimum baseline**. Differencing adjacent
polls aliases against Vast's own update schedule — consecutive readings measured
$1.30/hr then $2.90/hr while the true rate was a steady $2.26/hr. Neither was
wrong; they straddled an upstream update.

Both spend charts are scoped to the **selected window**, never to a clock
period. An earlier version reported "this hour" against a store that had been
running only a few minutes: the number was arithmetically correct but sat under
a label implying a full hour of coverage, so it read as far too small for the
fleet. The window is now stated on the axis and in the card header, and the two
cannot disagree.

The only forecast is the hatched **wedge** on the per-hour chart, drawn between
the low and high of the trailing realized burn — a wedge rather than a line
because the spread is the honest content of the estimate. It is never the
instantaneous sum of prices, which is a step function that jumps the moment a
worker is created or destroyed.

Runway is deliberately absent. With autobill on, credit is a sawtooth and
"hours until zero" answers nothing.

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

AWS is not given a credential at all: the `aws` CLI is invoked with the
operator's own profile (`VASTMON_AWS_PROFILE`, default `me`) and inherits
whatever SSO session that has. No key is read, stored or logged by this service,
and an expired session degrades the EC2 half only — see "The EC2 side" above.

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

Utilization colour is used in exactly one place: the branch rail, where green
means the branch is working and red means it is idling on your money. That is an
inverted scale on purpose — a GPU pinned at 99% is the outcome you are paying
for.

Per-instance readings — the cards and the table — are deliberately left
**uncoloured**. A wall of green/amber/red cells reads as a verdict on every
number and drowns the one place the signal actually matters. Instance gauges take
their branch's colour instead, so the arc marks identity rather than judgement.
