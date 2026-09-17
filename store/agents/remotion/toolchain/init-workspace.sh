#!/usr/bin/env bash
# Runs once in a fresh workspace (cwd = the workspace): links the shared node_modules in (instant,
# and one copy of Remotion for every workspace) and seeds the verdict.
set -euo pipefail
: "${HARNESS_DSH_DIR:?}"
mkdir -p .harness out public
[ -e node_modules ] || ln -s "$HARNESS_DSH_DIR/node_modules" node_modules
python3 "$HARNESS_DSH_DIR/toolchain/verdict.py" >/dev/null 2>&1 || true
