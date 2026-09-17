#!/usr/bin/env bash
# Runs once at install, cwd = the install dir: pdf.js into node_modules, from the lockfile. The reader
# itself (app/, lib/, viewer.mjs) has no build step.
set -euo pipefail
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || { echo "miss node >= 20 on PATH"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "miss npm on PATH"; exit 1; }
npm ci --silent --no-audit --no-fund
for f in build/pdf.min.mjs build/pdf.worker.min.mjs web/pdf_viewer.mjs web/pdf_viewer.css legacy/build/pdf.min.mjs legacy/web/pdf_viewer.mjs; do
  [ -f "node_modules/pdfjs-dist/$f" ] || { echo "miss pdfjs-dist/$f after npm ci"; exit 1; }
done
echo "ok   pdf.js $(node -p "require('pdfjs-dist/package.json').version") (viewer components, modern and legacy builds)"
