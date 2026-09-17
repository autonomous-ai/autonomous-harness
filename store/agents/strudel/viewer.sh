#!/usr/bin/env bash
# The pane. Harness runs this here with HARNESS_VIEWER_PORT and HARNESS_WORKSPACE.
set -euo pipefail
: "${HARNESS_VIEWER_PORT:?}"; : "${HARNESS_WORKSPACE:?}"
exec node "$(cd "$(dirname "$0")" && pwd)/viewer.mjs"
