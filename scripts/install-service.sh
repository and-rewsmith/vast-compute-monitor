#!/usr/bin/env bash
# ============================================================================
# Install the Vast compute monitor as a systemd *user* service.
# ============================================================================
# Run from a clone of this repo:
#
#     scripts/install-service.sh
#
# A *user* unit is deliberate: it needs no root, and localuser already has
# Linger=yes, so the service starts at boot and survives logout.
#
# The service talks only to the Vast HTTPS API, so it can run on any machine --
# it does not need to be near the GPUs it is watching.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_NAME="${VASTMON_UNIT:-vast-compute-monitor}"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_PATH="$UNIT_DIR/${UNIT_NAME}.service"
# 9595 is the dev-server dashboard, 9596 the health dashboard; this one takes 9597.
PORT="${VASTMON_PORT:-9597}"
BIND="${VASTMON_HOST:-0.0.0.0}"
INTERVAL="${VASTMON_INTERVAL:-30}"
RETENTION="${VASTMON_RETENTION_DAYS:-30}"

mkdir -p "$UNIT_DIR" "$REPO/state"

# Fail before installing anything if there is no API key -- an authless service
# would just restart-loop, or worse, sit there showing an empty fleet.
if [[ -z "${VAST_API_KEY:-}" && ! -s "$HOME/.config/vastai/vast_api_key" ]]; then
  echo "! No Vast API key found." >&2
  echo "  Set VAST_API_KEY, or log the CLI in:  vastai set api-key <key>" >&2
  exit 1
fi

# Generated rather than checked in, so the absolute paths always match wherever
# this clone actually lives.
cat > "$UNIT_PATH" <<UNIT
[Unit]
Description=Vast.ai Compute Monitor - live CPU/GPU utilization for rented instances
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${REPO}/backend
Environment=VASTMON_HOST=${BIND}
Environment=VASTMON_PORT=${PORT}
Environment=VASTMON_INTERVAL=${INTERVAL}
Environment=VASTMON_RETENTION_DAYS=${RETENTION}
Environment=VASTMON_STATE=${REPO}/state
ExecStart=${REPO}/backend/run.sh
Restart=always
RestartSec=10
StandardOutput=append:${REPO}/state/${UNIT_NAME}.log
StandardError=inherit

[Install]
WantedBy=default.target
UNIT

echo "▸ wrote $UNIT_PATH"

if ! loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q 'Linger=yes'; then
  echo "! Linger is off for $USER: the service will stop at logout and not start"
  echo "  at boot. Enable with:  sudo loginctl enable-linger $USER"
fi

systemctl --user daemon-reload
systemctl --user enable --now "${UNIT_NAME}.service"

echo "▸ waiting for http://localhost:${PORT}/healthz …"
for _ in $(seq 1 90); do
  # 2>/dev/null: connection-refused is expected while uvicorn boots.
  if curl -fsS -o /dev/null --max-time 2 "http://localhost:${PORT}/healthz" 2>/dev/null; then
    echo "▸ up: http://$(hostname):${PORT}"
    exit 0
  fi
  sleep 1
done

echo "! did not come up in 90s. Recent logs:" >&2
systemctl --user status "${UNIT_NAME}.service" --no-pager -n 30 >&2 || true
exit 1
