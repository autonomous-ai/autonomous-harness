#!/usr/bin/env bash
# Launch the Jev Archer viewer (Jev is the archer, tracking the sliding target and planting the bullseye).
set -euo pipefail
cd "$(dirname "$0")/.."
HARNESS_DSH_DIR="${HARNESS_DSH_DIR:-$PWD}"
exec node viewer/viewer.mjs
