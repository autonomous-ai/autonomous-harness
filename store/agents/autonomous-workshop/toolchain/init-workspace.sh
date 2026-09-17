#!/usr/bin/env bash
# The project's own workspace init (it builds the template's placeholder part so the 3D pane shows a
# body at once), cwd = the new workspace. The project expects its own checkout as HARNESS_DSH_DIR.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS_DSH_DIR="$here/upstream" exec "$here/upstream/harness/toolchain/init-workspace.sh"
