#!/usr/bin/env bash
# Runs once in a fresh workspace (cwd = the workspace): builds and renders the starter so the pane
# shows something before the first prompt, and seeds the verdict.
set -euo pipefail
: "${HARNESS_DSH_DIR:?}"
mkdir -p .harness out
PYTHONPATH="$HARNESS_DSH_DIR/toolchain" "$HARNESS_DSH_DIR/.venv/bin/python" scenes/hello.py >/dev/null 2>&1 || true
"$HARNESS_DSH_DIR/.venv/bin/python" "$HARNESS_DSH_DIR/toolchain/verdict.py" >/dev/null 2>&1 || true
