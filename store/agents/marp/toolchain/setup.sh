#!/usr/bin/env bash
# Harness DSH setup — install the pinned Marp toolchain into ./toolchain/node_modules. cwd = the
# install dir. Idempotent: a second run with the same lockfile is a no-op.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/toolchain"
command -v node >/dev/null 2>&1 || { echo "miss node — install Node 18 or newer (brew install node)"; exit 1; }
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi
echo "ok   marp toolchain $(node -p "require('@marp-team/marp-core/package.json').version")"
