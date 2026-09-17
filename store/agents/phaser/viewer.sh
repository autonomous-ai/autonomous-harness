#!/usr/bin/env bash
# The pane: Vite's dev server on the workspace, on the port Harness hands it, loopback only.
# Vite's HMR is what makes the pane live — the agent saves a scene, the game reloads in place.
set -euo pipefail
: "${HARNESS_VIEWER_PORT:?}"; : "${HARNESS_WORKSPACE:?}"
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$HARNESS_WORKSPACE"
# A workspace the user made by hand, or one whose link was lost: point it at the shared install.
[ -e node_modules ] || ln -s "$DIR/node_modules" node_modules
exec node_modules/.bin/vite --port "$HARNESS_VIEWER_PORT" --strictPort --host 127.0.0.1
