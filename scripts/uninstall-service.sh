#!/usr/bin/env bash
# Remove the systemd user service installed by install-service.sh.
# The SQLite history in state/ is left alone -- delete it by hand if you mean to.
set -euo pipefail

UNIT_NAME="${VASTMON_UNIT:-vast-compute-monitor}"
UNIT_PATH="$HOME/.config/systemd/user/${UNIT_NAME}.service"

systemctl --user disable --now "${UNIT_NAME}.service" 2>/dev/null || true
rm -f "$UNIT_PATH"
systemctl --user daemon-reload
echo "▸ removed ${UNIT_NAME}.service (history in state/ kept)"
