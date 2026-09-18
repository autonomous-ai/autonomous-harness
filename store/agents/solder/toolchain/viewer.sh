#!/usr/bin/env bash
# The project's own board viewer (viewer-only mode over the agent's workspace), on the port Harness
# hands it, on a Node of the package's own.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
. "$here/toolchain/runtimes.sh"
harness_node 22.12 || exit 1
HARNESS_DSH_DIR="$here/upstream/harness/kicad" CIRCUIT_PYTHON="${CIRCUIT_PYTHON:-$here/toolchain/python}" \
  exec "$here/upstream/harness/kicad/toolchain/viewer.sh"
