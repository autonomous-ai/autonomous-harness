#!/usr/bin/env bash
set -euo pipefail
studio_package="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$studio_package/.venv/bin:$PATH"
export PYTHONUNBUFFERED=1
exec "$studio_package/.venv/bin/python" "$studio_package/toolchain/workflow.py" "$@"
