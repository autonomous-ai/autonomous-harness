#!/usr/bin/env bash
# Launch the Jev Pendulum viewer (Jev balances a rod live on a pivot).
set -euo pipefail
cd "$(dirname "$0")/.."
HARNESS_DSH_DIR="${HARNESS_DSH_DIR:-$PWD}"
exec node viewer/viewer.mjs
