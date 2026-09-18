#!/usr/bin/env bash
# Launch the Jev Guard viewer (Jev judges the coding agent's live edits).
set -euo pipefail
cd "$(dirname "$0")/.."
HARNESS_DSH_DIR="${HARNESS_DSH_DIR:-$PWD}"
exec node viewer/viewer.mjs
