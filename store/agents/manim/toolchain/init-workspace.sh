#!/usr/bin/env bash
# Runs once in a fresh workspace (cwd = the workspace): renders the template scene at low quality so
# the pane plays something (chaptered) before the first prompt, and seeds the verdict.
set -euo pipefail
: "${HARNESS_DSH_DIR:?}"
mkdir -p .harness out
HARNESS_WORKSPACE="$PWD" "$HARNESS_DSH_DIR/.venv/bin/python" "$HARNESS_DSH_DIR/toolchain/render.py" -ql --disable_caching scenes/intro.py Intro >/dev/null 2>&1 \
  || "$HARNESS_DSH_DIR/.venv/bin/python" "$HARNESS_DSH_DIR/toolchain/verdict.py" >/dev/null 2>&1 || true
