#!/usr/bin/env bash
# The pane. Harness runs this here with HARNESS_VIEWER_PORT and HARNESS_WORKSPACE. viewer.mjs starts
# Remotion Studio on the workspace (on a private loopback port, BROWSER=none) and serves the pane on
# HARNESS_VIEWER_PORT: Studio itself, plus the renders in out/ and the render in progress.
set -euo pipefail
: "${HARNESS_VIEWER_PORT:?}"; : "${HARNESS_WORKSPACE:?}"
exec node "$(cd "$(dirname "$0")" && pwd)/viewer.mjs"
