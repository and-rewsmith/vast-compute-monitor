#!/usr/bin/env bash
# Bootstrap + launch the backend. Invoked by the systemd user unit, and usable
# directly for a foreground run. Idempotently provisions a venv, reinstalls deps
# only when requirements.txt changes, then supervises uvicorn.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
cd "$HERE"

PYTHON_BIN="${VASTMON_PYTHON:-python3}"
VENV_DIR="$HERE/.venv"
HOST="${VASTMON_HOST:-0.0.0.0}"
PORT="${VASTMON_PORT:-9597}"

if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

# Reinstall only when requirements.txt content changes (hash marker).
REQ_HASH="$(sha256sum requirements.txt | awk '{print $1}')"
MARKER="$VENV_DIR/.req-hash"
if [[ ! -f "$MARKER" || "$(cat "$MARKER" 2>/dev/null)" != "$REQ_HASH" ]]; then
  python -m pip install --upgrade pip >/dev/null
  python -m pip install -r requirements.txt
  echo "$REQ_HASH" > "$MARKER"
fi

mkdir -p "${VASTMON_STATE:-$REPO/state}"

# Fail loudly and early if there is no API key: an authless dashboard would
# otherwise sit there showing an empty fleet, which looks like "no instances".
python - <<'PY'
from app.vast import load_api_key
load_api_key()
PY

PIDFILE="$HERE/server.pid"
python -m uvicorn app.main:app --host "$HOST" --port "$PORT" --log-level warning &
UVICORN_PID=$!
echo "$UVICORN_PID" > "$PIDFILE"

shutdown() {
  kill "$UVICORN_PID" 2>/dev/null || true
  wait "$UVICORN_PID" 2>/dev/null || true
  rm -f "$PIDFILE"
}
trap shutdown HUP INT TERM EXIT
wait "$UVICORN_PID"
