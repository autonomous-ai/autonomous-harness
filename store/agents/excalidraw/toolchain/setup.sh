#!/usr/bin/env bash
# Runs once at install, cwd = the install dir. The pane's dependencies — Excalidraw's own package and
# the React it renders with — into node_modules, from the lockfile. Nothing global.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v node >/dev/null 2>&1 || { echo "miss node >= 18 on PATH"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "miss npm on PATH"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "miss python3 (the scene helper and the verdict)"; exit 1; }
echo "     npm ci (Excalidraw $(node -p "require('./package.json').dependencies['@excalidraw/excalidraw']"))"
npm ci --silent --no-audit --no-fund
[ -f node_modules/@excalidraw/excalidraw/dist/excalidraw.production.min.js ] || { echo "miss the Excalidraw bundle after npm ci"; exit 1; }
echo "ok   excalidraw $(node -p "require('@excalidraw/excalidraw/package.json').version") · react $(node -p "require('react/package.json').version")"
