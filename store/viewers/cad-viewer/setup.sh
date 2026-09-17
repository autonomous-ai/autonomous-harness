#!/usr/bin/env bash
# Runs once at install, cwd = this directory. Makes the one venv the viewer runs from: the pinned
# `cadgen` release, which carries the CAD Viewer's server and built client (no Node at run time).
# `cadquery-ocp` comes with it — that is the OpenCascade the viewer tessellates STEP with.
set -euo pipefail
cd "$(dirname "$0")"
CADGEN_VERSION="$(cat CADGEN_VERSION)"
PY=""
for candidate in python3.13 python3.12 python3.11 python3; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then
    PY="$candidate"; break
  fi
done
[ -n "$PY" ] || { echo "miss python 3.11+ (brew install python@3.12)"; exit 1; }
echo "ok   $($PY --version)"
if [ ! -x .venv/bin/python ]; then "$PY" -m venv .venv; fi
.venv/bin/python -m pip install --quiet --upgrade pip >/dev/null 2>&1 || true
echo "     installing cadgen $CADGEN_VERSION (this pulls OpenCascade; a few minutes the first time)"
.venv/bin/python -m pip install --quiet "cadgen==${CADGEN_VERSION}"
echo "ok   cadgen $(.venv/bin/cadgen --version 2>/dev/null || echo "$CADGEN_VERSION")"
