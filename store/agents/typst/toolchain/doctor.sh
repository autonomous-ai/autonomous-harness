#!/usr/bin/env bash
set -u; cd "$(dirname "$0")/.."
if [ -x bin/typst ]; then echo "ok   $(bin/typst --version)"; else echo "miss bin/typst — run toolchain/setup.sh"; exit 1; fi
if command -v python3 >/dev/null 2>&1; then echo "ok   $(python3 --version) for the verdict"; else echo "miss python3 for the verdict"; exit 1; fi
