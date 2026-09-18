#!/usr/bin/env bash
# Launch the Jev Slalom viewer (Jev is the racer, steering the skier to thread every gate).
set -euo pipefail
cd "$(dirname "$0")/.."
HARNESS_DSH_DIR="${HARNESS_DSH_DIR:-$PWD}"
exec node viewer/viewer.mjs
