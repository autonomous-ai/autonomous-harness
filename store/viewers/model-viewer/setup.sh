#!/usr/bin/env bash
# Runs once at install, cwd = the install dir: three.js into node_modules, from the lockfile, then the
# server's smoke test. Nothing here touches the machine outside this directory.
set -euo pipefail
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' || { echo "miss node >= 18 on PATH"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "miss npm on PATH"; exit 1; }
npm ci --silent --no-audit --no-fund
[ -f node_modules/three/build/three.module.js ] || { echo "miss three after npm ci"; exit 1; }
[ -f node_modules/three/examples/jsm/loaders/GLTFLoader.js ] || { echo "miss three's glTF loader after npm ci"; exit 1; }
npm test --silent
echo "ok   three $(node -p "require('./node_modules/three/package.json').version") (3D Viewer)"
