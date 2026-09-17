#!/usr/bin/env bash
# Runs once at install, cwd = the install dir. One venv with the pinned marimo and the libraries a
# notebook reaches for first (numpy, pandas, polars, altair, matplotlib, duckdb, pyarrow).
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="$(cat MARIMO_VERSION)"
PY=""; for c in python3.12 python3.13 python3.11 python3; do if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; raise SystemExit(0 if (3, 10) <= sys.version_info < (3, 14) else 1)' 2>/dev/null; then PY="$c"; break; fi; done
[ -n "$PY" ] || { echo "miss python 3.10–3.13 (brew install python@3.12)"; exit 1; }
echo "ok   $($PY --version)"
[ -x .venv/bin/python ] || "$PY" -m venv .venv
.venv/bin/python -m pip install --quiet --upgrade pip >/dev/null 2>&1 || true
echo "     installing marimo ${VERSION} and the usual libraries (a minute or two)"
.venv/bin/python -m pip install --quiet "marimo==${VERSION}" numpy pandas polars altair matplotlib duckdb pyarrow
echo "ok   marimo $(.venv/bin/marimo --version 2>/dev/null | tail -1)"
