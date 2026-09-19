#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
. ./runtimes.sh
harness_node 22
node --check server.mjs
echo 'ok Studio Viewer · local workspaces, interactive surfaces, run history'
