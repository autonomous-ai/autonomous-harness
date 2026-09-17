#!/usr/bin/env bash
# Exit 0 when this machine can run the viewer: only Node is needed.
set -u
if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)'; then echo "ok   node $(node --version)"; exit 0; fi
echo "miss node >= 18 on PATH"; exit 1
