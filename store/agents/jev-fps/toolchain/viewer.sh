#!/usr/bin/env bash
# Launch the Jev FPS viewer (Jev plays a first-person arena shooter, one typed decision at a time).
set -euo pipefail
cd "$(dirname "$0")/.."
HARNESS_DSH_DIR="${HARNESS_DSH_DIR:-$PWD}"
exec node viewer/viewer.mjs
