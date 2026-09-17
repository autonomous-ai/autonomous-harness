#!/usr/bin/env bash
set -u; cd "$(dirname "$0")/.."
if [ -x .venv/bin/marimo ]; then echo "ok   marimo $(.venv/bin/marimo --version 2>/dev/null | tail -1)"; else echo "miss .venv/bin/marimo — run toolchain/setup.sh"; exit 1; fi
