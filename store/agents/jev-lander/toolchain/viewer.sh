#!/usr/bin/env bash
# Launch the Jev Lander viewer (Jev is the flight computer, throttling a booster down to a soft landing).
set -euo pipefail
cd "$(dirname "$0")/.."
HARNESS_DSH_DIR="${HARNESS_DSH_DIR:-$PWD}"
exec node viewer/viewer.mjs
