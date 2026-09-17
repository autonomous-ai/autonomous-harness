#!/usr/bin/env bash
# Runs once in a fresh workspace (cwd = the workspace): seeds the verdict for the starter circuit,
# so the pane header has a state before the first prompt.
set -euo pipefail
: "${HARNESS_DSH_DIR:?}"
mkdir -p .harness
python3 "$HARNESS_DSH_DIR/toolchain/verdict.py" >/dev/null 2>&1 || true
