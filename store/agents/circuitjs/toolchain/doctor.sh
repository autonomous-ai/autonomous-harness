#!/usr/bin/env bash
# Exit 0 = this machine can run the harness. One line per check; Harness shows them.
set -u
cd "$(dirname "$0")/.."
bad=0
war=upstream/war
if [ -s "$war/circuitjs.html" ] && [ -s "$war/circuitjs1/circuitjs1.nocache.js" ] && ls "$war"/circuitjs1/*.cache.js >/dev/null 2>&1; then
  commit=$(sed -n 's/^commit=//p' upstream/INSTALLED 2>/dev/null)
  perms=$(ls "$war"/circuitjs1/*.cache.js 2>/dev/null | wc -l | tr -d ' ')
  echo "ok   circuitjs1 ${commit:0:12} · $perms compiled permutation(s) in upstream/"
else
  echo "miss upstream/ — run toolchain/setup.sh (it downloads CircuitJS1)"
  bad=1
fi
if [ -d "$war/circuitjs1/circuits" ]; then
  echo "ok   $(ls "$war/circuitjs1/circuits" | wc -l | tr -d ' ') example circuits in the Circuits menu"
else
  echo "miss upstream/war/circuitjs1/circuits — run toolchain/setup.sh"
  bad=1
fi
if command -v node >/dev/null 2>&1; then echo "ok   node $(node -v) (the pane)"; else echo "miss node >= 18 (the pane is a node server)"; bad=1; fi
if command -v python3 >/dev/null 2>&1; then echo "ok   $(python3 --version) (the verdict)"; else echo "miss python3 (the verdict)"; bad=1; fi
exit $bad
