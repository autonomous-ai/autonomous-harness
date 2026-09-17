#!/usr/bin/env bash
# Exit 0 when this machine can run the skills. One line per check; Harness shows them.
set -u
cd "$(dirname "$0")/.."
bad=0
if [ -x .venv/bin/cadgen ]; then echo "ok   cadgen $(cat CADGEN_VERSION)"; else echo "miss .venv/bin/cadgen — run toolchain/setup.sh"; bad=1; fi
if .venv/bin/cadgen doctor skills/cad >/dev/null 2>&1; then echo "ok   cadgen matches the skills' pin"; else echo "miss cadgen does not match skills/cad/requirements.txt"; bad=1; fi
if .venv/bin/python -c 'import build123d' >/dev/null 2>&1; then echo "ok   build123d + OpenCascade"; else echo "miss build123d in the venv"; bad=1; fi
if .venv/bin/python -c 'import trimesh, scipy, rtree, networkx, lxml' >/dev/null 2>&1; then echo "ok   dfam-check extras"; else echo "warn dfam-check extras missing (trimesh, scipy, rtree, networkx, lxml)"; fi
if .venv/bin/python -c 'from playwright.sync_api import sync_playwright' >/dev/null 2>&1; then echo "ok   playwright for snapshots"; else echo "warn playwright missing; snapshots will not render"; fi
exit $bad
