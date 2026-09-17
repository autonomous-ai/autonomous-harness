#!/usr/bin/env bash
# The pane. Harness runs this here with HARNESS_VIEWER_PORT, HARNESS_WORKSPACE and HARNESS_DSH_DIR
# (the harness that uses this viewer — where its Menagerie robots are).
set -euo pipefail
: "${HARNESS_VIEWER_PORT:?}"; : "${HARNESS_WORKSPACE:?}"
exec node "$(cd "$(dirname "$0")" && pwd)/viewer.mjs"
