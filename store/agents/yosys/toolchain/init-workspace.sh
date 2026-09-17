#!/usr/bin/env bash
# Runs once in a fresh workspace (cwd = the workspace): takes the starter design all the way to a
# bitstream, so the pane has a schematic, waves and a real LUT count before the first prompt.
#
# Quiet and forgiving — a machine missing nextpnr should still land in a workspace with a
# simulation and a schematic, and the verdict says which phase did not happen.
set -uo pipefail
: "${HARNESS_DSH_DIR:?}"
mkdir -p .harness out

# Homebrew's bin is not always on the PATH of a process the daemon spawned.
command -v yosys >/dev/null 2>&1 || export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

HARNESS_WORKSPACE="$PWD" bash "$HARNESS_DSH_DIR/toolchain/flow.sh" blink >out/logs-init.txt 2>&1 || true
# flow.sh always leaves a verdict; if it could not run at all, seed one so the header is not empty.
[ -f .harness/verdict.json ] || python3 "$HARNESS_DSH_DIR/toolchain/verdict.py" blink >/dev/null 2>&1 || true
