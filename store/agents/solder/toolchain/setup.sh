#!/usr/bin/env bash
# Runs once at install, cwd = the install dir: a Node and a Python of the package's own, then fetch
# Autonomous Circuit at the pinned commit and run the Solder package's OWN setup in it (Freerouting
# jar + JRE, the board viewer). KiCad is the machine's — doctor.sh reports it afterwards.
set -euo pipefail
cd "$(dirname "$0")/.."
. toolchain/runtimes.sh
harness_node 22.12 || exit 1
harness_venv .venv 3.12 3.10 || exit 1
toolchain/fetch-upstream.sh
[ -x upstream/harness/kicad/toolchain/setup.sh ] || { echo "miss upstream/harness/kicad/toolchain/setup.sh"; exit 1; }
HARNESS_DSH_DIR="$PWD/upstream/harness/kicad" CIRCUIT_PYTHON="$PWD/toolchain/python" \
  upstream/harness/kicad/toolchain/setup.sh
