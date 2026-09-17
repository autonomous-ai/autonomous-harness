#!/usr/bin/env bash
# Runs once at install, cwd = the install dir: <model-viewer> into node_modules, from the lockfile.
set -euo pipefail
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' || { echo "miss node >= 18 on PATH"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "miss npm on PATH"; exit 1; }
npm ci --silent --no-audit --no-fund
[ -f node_modules/@google/model-viewer/dist/model-viewer.min.js ] || { echo "miss model-viewer bundle after npm ci"; exit 1; }
echo "ok   model-viewer $(node -p "require('@google/model-viewer/package.json').version")"
