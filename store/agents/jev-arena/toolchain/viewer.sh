#!/usr/bin/env bash
# Jev Arena viewer launcher. Sets up the env the daemon supplies and execs the Node viewer.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${HARNESS_VIEWER_PORT:?HARNESS_VIEWER_PORT is required}"
: "${HARNESS_WORKSPACE:?HARNESS_WORKSPACE is required}"
command -v node >/dev/null 2>&1 || { echo "miss node" >&2; exit 1; }
exec node "$ROOT/viewer/viewer.mjs"
