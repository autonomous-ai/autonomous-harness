#!/usr/bin/env bash
# The pane: Remotion Studio on the workspace, on the port Harness hands it, without opening a browser
# of its own (BROWSER=none is how Remotion is told). Studio reloads as the source changes.
set -euo pipefail
: "${HARNESS_VIEWER_PORT:?}"; : "${HARNESS_WORKSPACE:?}"
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$HARNESS_WORKSPACE"
[ -e node_modules ] || ln -s "$DIR/node_modules" node_modules
export BROWSER=none
exec "$DIR/node_modules/.bin/remotion" studio --port "$HARNESS_VIEWER_PORT" --disable-keyboard-shortcuts=false src/index.ts
