#!/usr/bin/env bash
# Runs once in a fresh workspace (cwd = the workspace): links the shared node_modules in (instant,
# and one copy of Phaser for every workspace) and seeds the first verdict so the pane header has a
# state before the first prompt.
set -euo pipefail
: "${HARNESS_DSH_DIR:?}"
mkdir -p .harness out public src/scenes
[ -e node_modules ] || ln -s "$HARNESS_DSH_DIR/node_modules" node_modules
python3 "$HARNESS_DSH_DIR/toolchain/verdict.py" >/dev/null 2>&1 || true
