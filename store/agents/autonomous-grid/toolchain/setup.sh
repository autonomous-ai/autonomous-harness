#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
. ./VERSIONS
. toolchain/runtimes.sh
harness_node 22
version="$(toolchain/grid.sh version 2>/dev/null || true)"
if ! node --input-type=module - "$version" "$GRID_MIN_VERSION" <<'JS'
const parse = s => (s.match(/\d+\.\d+\.\d+/)?.[0] || '0.0.0').split('.').map(Number);
const a = parse(process.argv[2]), b = parse(process.argv[3]);
process.exit(a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] >= b[2]))) ? 0 : 1);
JS
then
  if [ -n "${HARNESS_GRID_BIN:-}" ] || [ -f "$HARNESS_RUNTIME/current-grid" ]; then
    echo "miss Grid >= $GRID_MIN_VERSION — update the selected Harness runtime, then run setup again"
    exit 1
  fi
  harness_venv .venv 3.12 3.11
  harness_pip .venv "git+$UPSTREAM_REPO@$UPSTREAM_COMMIT"
fi
echo "ok   $(toolchain/grid.sh version)"
echo 'ok   Grid viewer (no browser dependencies or model downloads needed)'
