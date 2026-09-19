#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
. toolchain/runtimes.sh
harness_node 22
test -x .venv/bin/python || { echo 'miss run toolchain/setup.sh to install the local runtime'; exit 1; }
if [ -x .sumo/bin/sumo ]; then .sumo/bin/sumo --version; .sumo/bin/netconvert --version;
else .venv/bin/sumo --version; .venv/bin/netconvert --version; fi
test -f upstream/README.md || { echo "miss pinned upstream sources"; exit 1; }
echo "ok upstream 10113c1e6ba2"
