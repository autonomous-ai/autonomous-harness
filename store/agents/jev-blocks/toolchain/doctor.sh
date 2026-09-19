#!/usr/bin/env bash
# Doctor: verify the runtime prerequisites for the Jev Blocks viewer.
set -euo pipefail
if ! command -v node >/dev/null 2>&1; then echo "fail   node is required (Node 18+)"; exit 1; fi
if ! node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)" 2>/dev/null; then
  echo "fail   node >= 18 required (found $(node -v))"; exit 1
fi
echo "ok   node $(node -v)"
cd "$(dirname "$0")/.."
node -e "import('./toolchain/jev.mjs').then((m) => console.log('ok   Jev: ' + m.describeCredentials())).catch((e) => console.log('warn   Jev client did not load: ' + e.message))"
echo "done"
