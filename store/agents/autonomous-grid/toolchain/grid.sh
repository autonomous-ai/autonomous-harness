#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
export GRID_NO_UPDATE_CHECK=1
# Same priority as Harness: explicit override, managed runtime, package fallback, user's CLI.
if [ -n "${HARNESS_GRID_BIN:-}" ]; then exec "$HARNESS_GRID_BIN" "$@"; fi
runtime="${ADAPTER_RUNTIME_DIR:-${HOME}/.harness/runtime}"
recorded="$(cat "$runtime/current-grid" 2>/dev/null || true)"
case "$recorded" in "$runtime"/*)
  if [ -x "$recorded" ]; then exec "$recorded" "$@"; fi ;;
esac
if [ -x "$here/.venv/bin/grid" ]; then exec "$here/.venv/bin/grid" "$@"; fi
if command -v grid >/dev/null 2>&1; then exec grid "$@"; fi
if [ -x "${HOME}/.local/bin/grid" ]; then exec "${HOME}/.local/bin/grid" "$@"; fi
echo 'Grid is missing. Run this harness’s toolchain/setup.sh.' >&2
exit 127
