#!/usr/bin/env bash
# Launch the Jev Launcher viewer (Jev ranks a launch palette live per keystroke).
set -euo pipefail
cd "$(dirname "$0")/.."
HARNESS_DSH_DIR="${HARNESS_DSH_DIR:-$PWD}"
exec node viewer/viewer.mjs
