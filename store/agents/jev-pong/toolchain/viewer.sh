#!/usr/bin/env bash
# Launch the Jev Pong viewer (Jev defends a rally as the paddle, live).
set -euo pipefail
cd "$(dirname "$0")/.."
HARNESS_DSH_DIR="${HARNESS_DSH_DIR:-$PWD}"
exec node viewer/viewer.mjs
