#!/usr/bin/env bash
# Launch the Jev Blocks viewer (Jev plays a falling-blocks puzzle, one placement decision per piece).
set -euo pipefail
cd "$(dirname "$0")/.."
HARNESS_DSH_DIR="${HARNESS_DSH_DIR:-$PWD}"
exec node viewer/viewer.mjs
