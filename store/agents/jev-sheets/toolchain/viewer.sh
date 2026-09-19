#!/usr/bin/env bash
# Launch the Jev Sheets viewer (a live spreadsheet where every column header is a question Jev answers for each row).
set -euo pipefail
cd "$(dirname "$0")/.."
HARNESS_DSH_DIR="${HARNESS_DSH_DIR:-$PWD}"
exec node viewer/viewer.mjs
