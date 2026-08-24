#!/usr/bin/env bash
# Refresh src/cable/vectors/cable_frame.txt from the repository that generates it.
#
#   scripts/sync-cable-vectors.sh            # copy in, report whether anything changed
#   scripts/sync-cable-vectors.sh --check    # fail if the copy is stale (for CI, when the source is there)
#
# The vectors are generated in autonomous-code by apps/esp32-circle/scripts/gen_cable_vectors.py — a
# third implementation written from the format description, so neither the firmware's decoder nor this
# repository's blesses its own misreading. That only holds while the copy here is current: a stale copy
# lets both suites pass while the real cable disagrees.
#
# The source repository is private and most people cloning this one will not have it. Its absence is
# therefore NOT an error — the copy is checked in and works on its own; this script exists for whoever
# changes the format.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dest="$here/../src/cable/vectors/cable_frame.txt"
src="${AUTONOMOUS_CODE:-$HOME/go/src/github.com/autonomous-ai/autonomous-code}/apps/esp32-circle/test/vectors/cable_frame.txt"

if [ ! -f "$src" ]; then
  echo "source vectors not found: $src"
  echo "(set AUTONOMOUS_CODE to the autonomous-code checkout; skipping)"
  exit 0
fi

if diff -q "$src" "$dest" >/dev/null 2>&1; then
  echo "up to date: $dest"
  exit 0
fi

if [ "${1:-}" = "--check" ]; then
  echo "STALE: $dest differs from $src" >&2
  diff "$dest" "$src" | head -20 >&2
  exit 1
fi

cp "$src" "$dest"
echo "updated: $dest"
echo "now run: npx vitest run src/cable/cableFrame.spec.ts"
