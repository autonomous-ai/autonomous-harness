#!/usr/bin/env bash
# Runs once at install, cwd = the install dir. Strudel's REPL — the whole engine — into this
# package's node_modules, from the lockfile, as npm publishes it. Nothing global, nothing vendored
# into this repository, no CDN at run time.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v node >/dev/null 2>&1 || { echo "miss node >= 18 on PATH"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "miss npm on PATH"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "miss python3 (the verdict)"; exit 1; }
echo "     npm ci (@strudel/repl $(node -p "require('./package.json').dependencies['@strudel/repl']"))"
npm ci --silent --no-audit --no-fund
[ -f node_modules/@strudel/repl/dist/index.js ] || { echo "miss the Strudel REPL bundle after npm ci"; exit 1; }
echo "ok   strudel $(node -p "require('@strudel/repl/package.json').version") · AGPL-3.0-or-later, from npm, unmodified"
