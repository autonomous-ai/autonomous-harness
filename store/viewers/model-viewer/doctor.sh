#!/usr/bin/env bash
set -u; cd "$(dirname "$0")"
if [ -f node_modules/@google/model-viewer/dist/model-viewer.min.js ]; then echo "ok   model-viewer $(node -p "require('@google/model-viewer/package.json').version")"; else echo "miss node_modules — run ./setup.sh"; exit 1; fi
