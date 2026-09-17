#!/usr/bin/env bash
# Runs once at install, cwd = the install dir. One venv with the cadgen release every skill in
# skills/ pins (their requirements.txt), plus the extras dfam-check needs and the browser
# snapshots render with. Nothing is installed outside this directory.
set -euo pipefail
cd "$(dirname "$0")/.."
CADGEN_VERSION="$(cat CADGEN_VERSION)"
PY=""
for candidate in python3.13 python3.12 python3.11 python3; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then
    PY="$candidate"; break
  fi
done
[ -n "$PY" ] || { echo "miss python 3.11+ (brew install python@3.12)"; exit 1; }
echo "ok   $($PY --version)"
[ -x .venv/bin/python ] || "$PY" -m venv .venv
.venv/bin/python -m pip install --quiet --upgrade pip >/dev/null 2>&1 || true
echo "     installing cadgen $CADGEN_VERSION and the skills' extras (OpenCascade comes with it; minutes the first time)"
.venv/bin/python -m pip install --quiet "cadgen[snapshot]==${CADGEN_VERSION}" trimesh numpy scipy rtree networkx lxml
echo "ok   cadgen $CADGEN_VERSION"
echo "     installing the browser snapshots render with"
if .venv/bin/python -m playwright install chromium >/dev/null 2>&1; then echo "ok   chromium for snapshots"; else echo "warn chromium for snapshots did not install; \`cadgen … snapshot\` will not render until \`.venv/bin/python -m playwright install chromium\` succeeds"; fi
