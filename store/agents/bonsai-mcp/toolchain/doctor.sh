#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
. toolchain/runtimes.sh
harness_node 22
test -x .venv/bin/python || { echo 'miss run toolchain/setup.sh to install the local runtime'; exit 1; }
.venv/bin/python -c 'import ifcopenshell; import json; json.load(open("studio.config.json")); print("ok Bonsai MCP local workflow")'
test -f upstream/README.md || { echo "miss pinned upstream sources"; exit 1; }
echo "ok upstream 12cf135f6985"
