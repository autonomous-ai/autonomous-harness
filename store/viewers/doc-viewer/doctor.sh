#!/usr/bin/env bash
set -u; cd "$(dirname "$0")"
if [ -f node_modules/pdfjs-dist/build/pdf.min.mjs ]; then echo "ok   pdf.js $(node -p "require('pdfjs-dist/package.json').version")"; else echo "miss node_modules — run ./setup.sh"; exit 1; fi
