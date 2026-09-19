#!/usr/bin/env bash
set -euo pipefail
exec "${HARNESS_DSH_DIR:?}/toolchain/run.sh" train
