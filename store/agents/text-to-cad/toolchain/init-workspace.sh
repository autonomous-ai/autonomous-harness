#!/usr/bin/env bash
# Runs once in a fresh workspace (cwd = the workspace) after the template was copied. Builds the
# starter model so the pane has a part to show before the first prompt, and seeds the verdict.
set -euo pipefail
: "${HARNESS_DSH_DIR:?HARNESS_DSH_DIR is required}"
mkdir -p .harness STEP tmp
"$HARNESS_DSH_DIR/.venv/bin/python" src/part.py >/dev/null 2>&1 || true
"$HARNESS_DSH_DIR/.venv/bin/python" "$HARNESS_DSH_DIR/toolchain/verdict.py" >/dev/null 2>&1 || true
