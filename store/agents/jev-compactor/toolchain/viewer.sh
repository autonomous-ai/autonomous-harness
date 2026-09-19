#!/usr/bin/env bash
# Launch the Jev Compactor viewer (Jev judges every tool result in a made-up agent session and compacts the context).
set -euo pipefail
cd "$(dirname "$0")/.."
HARNESS_DSH_DIR="${HARNESS_DSH_DIR:-$PWD}"
exec node viewer/viewer.mjs
