#!/usr/bin/env bash
# Exit 0 when this machine can run the viewer. One line per check; Harness shows them.
set -u
cd "$(dirname "$0")"
ok=0
if [ -x .venv/bin/cadgen ]; then echo "ok   cadgen $(.venv/bin/cadgen doctor . 2>/dev/null | head -1 || cat CADGEN_VERSION)"; else echo "miss .venv/bin/cadgen — run setup.sh"; ok=1; fi
if .venv/bin/python -c 'import build123d' >/dev/null 2>&1; then echo "ok   build123d + OpenCascade"; else echo "miss build123d (OpenCascade) in the venv"; ok=1; fi
exit $ok
