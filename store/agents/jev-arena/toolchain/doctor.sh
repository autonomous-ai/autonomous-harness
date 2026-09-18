#!/usr/bin/env bash
# Jev Arena doctor — one line per machine readiness check.
set -euo pipefail
node_v="$(command -v node >/dev/null 2>&1 && node -v || true)"
if [ -n "$node_v" ]; then
  major="$(printf '%s' "$node_v" | sed 's/^v//; s/\..*//')"
  if [ "$major" -ge 18 ] 2>/dev/null; then
    echo "ok   node $node_v"
    exit 0
  else
    echo "miss node >= 18 (have $node_v)"
    exit 1
  fi
fi
echo "miss node (>= 18)"
exit 1
