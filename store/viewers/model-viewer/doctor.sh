#!/usr/bin/env bash
set -u; cd "$(dirname "$0")"
fail=0
if command -v node >/dev/null 2>&1; then echo "ok   node $(node --version)"; else echo "miss node on PATH"; fail=1; fi
if [ -f node_modules/three/build/three.module.js ] && [ -f node_modules/three/examples/jsm/loaders/GLTFLoader.js ]; then
  echo "ok   three $(node -p "require('./node_modules/three/package.json').version")"
else
  echo "miss node_modules/three — run ./setup.sh"; fail=1
fi
[ -f web/index.html ] && [ -f web/app.js ] || { echo "miss web/ — the package is incomplete"; fail=1; }
exit $fail
