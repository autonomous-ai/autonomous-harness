#!/usr/bin/env bash
# Launch the Jev Firehose viewer (Jev triages a stream of made-up inbox messages, one call each).
set -euo pipefail
cd "$(dirname "$0")/.."
HARNESS_DSH_DIR="${HARNESS_DSH_DIR:-$PWD}"
exec node viewer/viewer.mjs
