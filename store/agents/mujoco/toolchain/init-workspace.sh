#!/usr/bin/env bash
# Runs once in a fresh workspace (cwd = the workspace): a first rollout so the pane plays something
# before the first prompt, and the verdict.
set -euo pipefail
: "${HARNESS_DSH_DIR:?}"
mkdir -p .harness out
PYTHONPATH="$HARNESS_DSH_DIR/toolchain" MENAGERIE="$HARNESS_DSH_DIR/menagerie" "$HARNESS_DSH_DIR/.venv/bin/python" sim/hello.py >/dev/null 2>&1 || true
PYTHONPATH="$HARNESS_DSH_DIR/toolchain" "$HARNESS_DSH_DIR/.venv/bin/python" "$HARNESS_DSH_DIR/toolchain/verdict.py" >/dev/null 2>&1 || true
