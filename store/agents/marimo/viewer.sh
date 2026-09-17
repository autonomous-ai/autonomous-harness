#!/usr/bin/env bash
# The pane: marimo's own editor on the workspace's notebook, headless (no browser of its own), on the
# port Harness hands it, watching the file so the agent's edits on disk show up as they land.
set -euo pipefail
: "${HARNESS_VIEWER_PORT:?}"; : "${HARNESS_WORKSPACE:?}"
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$HARNESS_WORKSPACE"
exec "$DIR/.venv/bin/marimo" edit --headless --host 127.0.0.1 --port "$HARNESS_VIEWER_PORT" --no-token --watch --skip-update-check notebook.py
