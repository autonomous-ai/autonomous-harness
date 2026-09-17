#!/usr/bin/env bash
# The project's own board viewer, over the agent's workspace, on the port Harness hands it.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS_DSH_DIR="$here/upstream" exec "$here/upstream/harness/toolchain/viewer.sh"
