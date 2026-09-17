#!/usr/bin/env bash
set -u; cd "$(dirname "$0")/.."; bad=0
if [ -x node_modules/.bin/vite ]; then
  echo "ok   phaser $(node -p "require('./node_modules/phaser/package.json').version") · vite $(node -p "require('./node_modules/vite/package.json').version")"
else
  echo "miss node_modules — run toolchain/setup.sh"; bad=1
fi
if [ -f skills/scenes/SKILL.md ] && [ -f skills/harness-phaser/SKILL.md ]; then
  echo "ok   skills: $(find skills -name SKILL.md | wc -l | tr -d ' ')"
else
  echo "miss skills/ — the checkout is incomplete"; bad=1
fi
command -v python3 >/dev/null 2>&1 && echo "ok   $(python3 --version)" || { echo "miss python3 (the verdict)"; bad=1; }
exit $bad
