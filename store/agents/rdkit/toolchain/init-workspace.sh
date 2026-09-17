#!/usr/bin/env bash
# Runs once in a fresh workspace (cwd = the workspace): the starter molecule, so the pane has
# something to rotate before the first prompt, and the verdict that describes it.
set -euo pipefail
: "${HARNESS_DSH_DIR:?}"
mkdir -p .harness out
PYTHONPATH="$HARNESS_DSH_DIR/toolchain" "$HARNESS_DSH_DIR/.venv/bin/python" molecules/hello.py >/dev/null 2>&1 || true
PYTHONPATH="$HARNESS_DSH_DIR/toolchain" "$HARNESS_DSH_DIR/.venv/bin/python" "$HARNESS_DSH_DIR/toolchain/verdict.py" >/dev/null 2>&1 || true
