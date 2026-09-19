#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
. toolchain/runtimes.sh
harness_node 22
harness_venv .venv 3.11 3.11 3.12
.venv/bin/python toolchain/studio_fetch.py
if [ -s requirements.lock ]; then harness_pip .venv --require-hashes -r requirements.lock; fi
exec toolchain/doctor.sh
