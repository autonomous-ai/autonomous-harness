#!/usr/bin/env bash
# Launch the Jev Conductor viewer (runs Jev as composer, streams to the pane).
set -euo pipefail
cd "$(dirname "$0")/.."
HARNESS_DSH_DIR="${HARNESS_DSH_DIR:-$PWD}"
exec node viewer/viewer.mjs
