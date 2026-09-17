#!/usr/bin/env bash
# Runs once in a fresh workspace (cwd = the workspace): seeds the verdict for the starter notebook.
set -euo pipefail
: "${HARNESS_DSH_DIR:?}"
mkdir -p .harness
"$HARNESS_DSH_DIR/.venv/bin/python" "$HARNESS_DSH_DIR/toolchain/verdict.py" >/dev/null 2>&1 || true
