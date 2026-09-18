#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
. toolchain/runtimes.sh
harness_node 22
exec node viewer.mjs
