#!/usr/bin/env bash
# The pane: marimo's own editor on the workspace's notebook, headless (no browser of its own), on the
# port Harness hands it, watching the file so the agent's edits on disk show up as they land.
# viewer.py starts `marimo edit --headless --no-token --watch notebook.py` with three pane settings
# layered on top (run on open, re-run what the agent changed, never autosave over the agent's file);
# harness.json opens it in marimo's app view (?view-as=present), outputs first, code one click away.
set -euo pipefail
: "${HARNESS_VIEWER_PORT:?}"; : "${HARNESS_WORKSPACE:?}"
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/.venv/bin/python" "$DIR/viewer.py"
