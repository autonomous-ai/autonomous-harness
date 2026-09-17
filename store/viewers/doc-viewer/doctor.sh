#!/usr/bin/env bash
set -u; cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || { echo "miss node >= 20 on PATH"; exit 1; }
for f in build/pdf.min.mjs build/pdf.worker.min.mjs web/pdf_viewer.mjs web/pdf_viewer.css legacy/build/pdf.min.mjs legacy/web/pdf_viewer.mjs; do
  [ -f "node_modules/pdfjs-dist/$f" ] || { echo "miss node_modules/pdfjs-dist/$f — run ./setup.sh"; exit 1; }
done
for f in app/index.html app/app.js app/app.css lib/workspace.mjs; do
  [ -f "$f" ] || { echo "miss $f — the package is incomplete"; exit 1; }
done
echo "ok   pdf.js $(node -p "require('pdfjs-dist/package.json').version") and the reader"
