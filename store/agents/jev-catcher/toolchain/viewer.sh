#!/usr/bin/env bash
# Launch the Jev Catcher viewer (Jev is the fielder, sliding the glove to catch every pop fly).
set -euo pipefail
cd "$(dirname "$0")/.."
HARNESS_DSH_DIR="${HARNESS_DSH_DIR:-$PWD}"
exec node viewer/viewer.mjs
