#!/usr/bin/env bash
# Runs once in a fresh workspace (cwd = the workspace): compiles the template so the pane has a page
# before the first prompt, and seeds the verdict.
set -euo pipefail
: "${HARNESS_DSH_DIR:?}"
mkdir -p .harness out
"$HARNESS_DSH_DIR/bin/typst" compile main.typ out/main.pdf >/dev/null 2>&1 || true
python3 "$HARNESS_DSH_DIR/toolchain/verdict.py" >/dev/null 2>&1 || true
