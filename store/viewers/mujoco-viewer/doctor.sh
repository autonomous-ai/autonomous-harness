#!/usr/bin/env bash
set -u; cd "$(dirname "$0")"
fail=0
if [ -f node_modules/@mujoco/mujoco/mujoco.wasm ]; then echo "ok   mujoco $(node -p "require('./node_modules/@mujoco/mujoco/package.json').version") (wasm)"; else echo "miss node_modules/@mujoco/mujoco — run ./setup.sh"; fail=1; fi
if [ -f node_modules/three/build/three.module.js ]; then echo "ok   three $(node -p "require('./node_modules/three/package.json').version")"; else echo "miss node_modules/three — run ./setup.sh"; fail=1; fi
if [ -f public/main.js ] && [ -f public/index.html ]; then echo "ok   pane (public/)"; else echo "miss public/ — this package is incomplete"; fail=1; fi
exit $fail
