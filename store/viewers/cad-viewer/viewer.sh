#!/usr/bin/env bash
# The pane. Harness runs this in this directory with:
#   HARNESS_VIEWER_PORT   the loopback port to listen on (strict: this one or fail)
#   HARNESS_WORKSPACE     the harness's workspace — the ONE directory the viewer serves
#   HARNESS_DSH           the harness it draws for (informational)
# `cadgen viewer` serves the directory it is started in; `?file=` picks an artifact inside it, which
# is what the URL template's ${artifact} becomes. --new/--no-registry: this instance belongs to
# Harness for the life of the pane, never reused by or for anything else. --dist: the pinned client
# with its fetches kept on loopback (pane_client.py says why); without it, the bundled client.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
: "${HARNESS_VIEWER_PORT:?HARNESS_VIEWER_PORT is required}"
: "${HARNESS_WORKSPACE:?HARNESS_WORKSPACE is required}"
DIST="$("$HERE/.venv/bin/python" "$HERE/pane_client.py" 2>/dev/null || true)"
cd "$HARNESS_WORKSPACE"
exec "$HERE/.venv/bin/cadgen" viewer --host 127.0.0.1 --port "$HARNESS_VIEWER_PORT" --new --no-registry ${DIST:+--dist "$DIST"}
