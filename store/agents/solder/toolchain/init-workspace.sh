#!/usr/bin/env bash
# The package's own workspace init, cwd = the new workspace. Solder's init expects HARNESS_DSH_DIR
# to be its own package dir (it runs `$HARNESS_DSH_DIR/toolchain/python` to seed the verdict).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS_DSH_DIR="$here/upstream/harness/kicad" CIRCUIT_PYTHON="${CIRCUIT_PYTHON:-$here/toolchain/python}" \
  exec "$here/upstream/harness/kicad/toolchain/init-workspace.sh"
