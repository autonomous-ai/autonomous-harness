#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
. ./runtimes.sh
harness_node 22
exec ./doctor.sh
