#!/usr/bin/env bash
set -u; cd "$(dirname "$0")/.."; bad=0
if [ -x node_modules/.bin/remotion ]; then echo "ok   remotion $(node -p "require('remotion/package.json').version")"; else echo "miss node_modules — run toolchain/setup.sh"; bad=1; fi
if [ -f upstream/skills/remotion-best-practices/SKILL.md ]; then echo "ok   skills @ $(cat upstream/.harness-commit 2>/dev/null)"; else echo "miss upstream skills — run toolchain/setup.sh"; bad=1; fi
if [ -x toolchain/remotion ] && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' 2>/dev/null; then echo "ok   \$REMOTION (render progress for the pane) · node $(node -v)"; else echo "miss node >= 18 or an executable toolchain/remotion"; bad=1; fi
command -v python3 >/dev/null 2>&1 && echo "ok   $(python3 --version)" || { echo "miss python3"; bad=1; }
exit $bad
