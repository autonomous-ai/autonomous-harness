#!/bin/sh
# Exit 0 when this machine can run the harness. Print one line per check; Harness shows them.
command -v sh >/dev/null 2>&1 && echo "ok   sh" || { echo "miss sh"; exit 1; }
