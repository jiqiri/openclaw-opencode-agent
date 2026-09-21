#!/bin/bash
# Start opencode serve (v2 API) + opencode-proxy v4.0
# Handles OPENCODE_SERVER_PASSWORD persistence across restarts.
set -e
PW_FILE="$HOME/.openclaw/.opencode-password"
LOG_DIR="$HOME/.openclaw/logs"
mkdir -p "$LOG_DIR"

if [ ! -f "$PW_FILE" ]; then
  openssl rand -hex 32 2>/dev/null > "$PW_FILE" || echo "dev-pw-$(date +%s)" > "$PW_FILE"
  chmod 600 "$PW_FILE"
fi
export OPENCODE_SERVER_PASSWORD
OPENCODE_SERVER_PASSWORD=$(cat "$PW_FILE")

check_port() { ss -tlnp 2>/dev/null | grep -q ":$1 " && return 0 || return 1; }
wait_for_port() {
  local port=$1 name=$2 max_wait=$3 waited=0
  while ! check_port "$port" && [ "$waited" -lt "$max_wait" ]; do sleep 1; waited=$((waited + 1)); done
  check_port "$port" && echo "[$(date)] $name ready on port $port (${waited}s)" && return 0
  echo "[$(date)] WARNING: $name failed on port $port after ${max_wait}s"; return 1
}

if ! check_port 5100; then
  echo "[$(date)] Starting opencode serve..."
  nohup opencode serve --hostname=127.0.0.1 --port=5100 > "$LOG_DIR/opencode-sdk.log" 2>&1 &
  wait_for_port 5100 "opencode serve" 20
fi

if ! check_port 5200; then
  if check_port 5100; then
    echo "[$(date)] Starting proxy v4.0..."
    cd ~/.openclaw
    nohup node opencode-proxy.js > "$LOG_DIR/proxy.log" 2>&1 &
    wait_for_port 5200 "Proxy" 10
  else
    echo "[$(date)] ERROR: SDK not on 5100, proxy not started"; exit 1
  fi
fi

echo "SDK   : $(check_port 5100 && echo 'UP 127.0.0.1:5100' || echo 'DOWN')"
echo "Proxy : $(check_port 5200 && echo 'UP 127.0.0.1:5200' || echo 'DOWN')"
curl -s http://127.0.0.1:5200/health 2>/dev/null; echo
