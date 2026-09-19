#!/bin/sh
# Exit 0 when this machine can run the harness. Print one line per check; Harness shows them.
command -v sh >/dev/null 2>&1 && echo "ok   sh (world generator)" || { echo "miss sh"; exit 1; }
# A browser pass helps the agent verify; warn, don't fail, without it.
command -v node >/dev/null 2>&1 && echo "ok   node (for headless verify)" || echo "note node optional: camera-verify needs a browser"
exit 0
