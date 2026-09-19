#!/usr/bin/env bash
# Doctor: verify the runtime prerequisites for the Jev Slalom viewer.
set -euo pipefail
if ! command -v node >/dev/null 2>&1; then echo "fail   node is required (Node 18+)"; exit 1; fi
if ! node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)" 2>/dev/null; then
  echo "fail   node >= 18 required (found $(node -v))"; exit 1
fi
echo "ok   node $(node -v)"
echo "done"
