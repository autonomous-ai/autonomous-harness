#!/usr/bin/env bash
# The project's own workspace init, cwd = the new workspace. HARNESS_DSH_DIR is this wrapper; the
# project expects its own checkout there.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS_DSH_DIR="$here/upstream" exec "$here/upstream/harness/toolchain/init-workspace.sh"
