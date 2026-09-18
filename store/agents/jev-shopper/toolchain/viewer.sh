#!/usr/bin/env bash
# Launch the Jev Shopper viewer (Jev calls the best buy as prices stream in, live).
set -euo pipefail
cd "$(dirname "$0")/.."
HARNESS_DSH_DIR="${HARNESS_DSH_DIR:-$PWD}"
exec node viewer/viewer.mjs
