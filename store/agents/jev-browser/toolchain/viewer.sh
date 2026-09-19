#!/usr/bin/env bash
# Launch the Jev Browser viewer (Jev operates a made-up travel site, one picked element per step).
set -euo pipefail
cd "$(dirname "$0")/.."
HARNESS_DSH_DIR="${HARNESS_DSH_DIR:-$PWD}"
exec node viewer/viewer.mjs
