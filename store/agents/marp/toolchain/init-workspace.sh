#!/usr/bin/env bash
# Runs once in a fresh workspace (cwd = the workspace) after the template was copied. Seeds the
# verdict from the template deck, so the pane header has a state before the agent's first turn.
set -euo pipefail
: "${HARNESS_DSH_DIR:?HARNESS_DSH_DIR is required}"
mkdir -p .harness assets
node "$HARNESS_DSH_DIR/toolchain/check.mjs" deck.md >/dev/null 2>&1 || true
