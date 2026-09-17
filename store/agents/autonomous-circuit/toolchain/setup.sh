#!/usr/bin/env bash
# Runs once at install, cwd = the install dir: fetch Autonomous Circuit at the pinned commit, then
# run the project's OWN setup in it (pinned tscircuit toolchain, skill runtimes, the board viewer).
set -euo pipefail
cd "$(dirname "$0")/.."
toolchain/fetch-upstream.sh
[ -x upstream/harness/toolchain/setup.sh ] || { echo "miss upstream/harness/toolchain/setup.sh"; exit 1; }
HARNESS_DSH_DIR="$PWD/upstream" upstream/harness/toolchain/setup.sh
