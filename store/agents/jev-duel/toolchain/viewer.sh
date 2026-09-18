#!/usr/bin/env bash
# Launch the Jev Duel viewer (Jev plays both sides, a third Jev referees).
set -euo pipefail
cd "$(dirname "$0")/.."
HARNESS_DSH_DIR="${HARNESS_DSH_DIR:-$PWD}"
exec node viewer/viewer.mjs
