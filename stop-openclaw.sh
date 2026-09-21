#!/bin/bash
# Stop opencode serve + proxy (leaves password file in place).
echo "[$(date)] Stopping services..."
pkill -f "opencode serve.*port=5100" 2>/dev/null || true
pkill -f "opencode-proxy.js" 2>/dev/null || true
sleep 1
for port in 5100 5200; do
  if ss -tlnp 2>/dev/null | grep -q ":$port "; then echo "  WARNING: port $port still in use";
  else echo "  Port $port: freed"; fi
done
echo "[$(date)] Done"
