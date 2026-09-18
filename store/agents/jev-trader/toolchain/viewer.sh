#!/usr/bin/env bash
# Launch the Jev Trader viewer (Jev trades a synthetic market, live).
set -euo pipefail
cd "$(dirname "$0")/.."
HARNESS_DSH_DIR="${HARNESS_DSH_DIR:-$PWD}"
exec node viewer/viewer.mjs
