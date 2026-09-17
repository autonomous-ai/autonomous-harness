#!/usr/bin/env bash
set -u; cd "$(dirname "$0")/.."; bad=0
if [ -f node_modules/@strudel/repl/dist/index.js ]; then echo "ok   strudel $(node -p "require('@strudel/repl/package.json').version") (the pane's REPL)"; else echo "miss node_modules — run toolchain/setup.sh"; bad=1; fi
if command -v node >/dev/null 2>&1; then echo "ok   node $(node --version) (the pane server and the syntax check)"; else echo "miss node >= 18"; bad=1; fi
if command -v python3 >/dev/null 2>&1; then echo "ok   $(python3 --version) (the verdict)"; else echo "miss python3"; bad=1; fi
echo "note the pane needs a click to start audio, and sample banks (bd, sd, hh) need the internet — synths do not"
exit $bad
