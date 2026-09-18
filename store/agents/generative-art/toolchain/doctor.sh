#!/bin/sh
# Exit 0 when this machine can run the harness. Print one line per check; Harness shows them.
command -v sh >/dev/null 2>&1 && echo "ok   sh (art runtime)" || { echo "miss sh"; exit 1; }
command -v node >/dev/null 2>&1 && echo "ok   node (for seed-census verify)" || echo "note node optional: seed census needs node"
exit 0
