#!/usr/bin/env bash
# Runs once at install, cwd = the install dir: MuJoCo's WASM build and three.js into node_modules,
# from the lockfile. Nothing here touches the machine outside this directory.
set -euo pipefail
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' || { echo "miss node >= 18 on PATH"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "miss npm on PATH"; exit 1; }
npm ci --silent --no-audit --no-fund
[ -f node_modules/@mujoco/mujoco/mujoco.wasm ] || { echo "miss mujoco.wasm after npm ci"; exit 1; }
[ -f node_modules/three/build/three.module.js ] || { echo "miss three after npm ci"; exit 1; }
npm test --silent
echo "ok   mujoco $(node -p "require('./node_modules/@mujoco/mujoco/package.json').version") (wasm) · three $(node -p "require('./node_modules/three/package.json').version")"
