#!/usr/bin/env bash
# Runs once at install, cwd = the install dir. One node_modules here (Remotion, its CLI, React,
# TypeScript) that every workspace links to, the headless browser Remotion renders with, and
# Remotion's own agent skills fetched at a pinned commit — fetched, not copied into this package,
# because that repository carries no licence to copy under.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
. ./VERSIONS
command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' || { echo "miss node >= 18 on PATH"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "miss npm on PATH"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "miss python3 (the verdict)"; exit 1; }
echo "     npm ci (remotion ${REMOTION}, a few minutes the first time)"
npm ci --silent --no-audit --no-fund
echo "ok   remotion $(node -p "require('remotion/package.json').version") · react $(node -p "require('react/package.json').version")"
echo "     remotion browser ensure (the headless Chrome renders use)"
node_modules/.bin/remotion browser ensure >/dev/null 2>&1 && echo "ok   headless browser" || echo "warn no headless browser yet — renders will fetch it on first use"
if [ ! -f upstream/.harness-commit ] || [ "$(cat upstream/.harness-commit)" != "${SKILLS_COMMIT}" ]; then
  echo "     fetching remotion-dev/skills @ ${SKILLS_COMMIT}"
  rm -rf upstream; mkdir upstream; cd upstream
  git init -q; git remote add origin https://github.com/remotion-dev/skills.git
  git fetch -q --depth 1 origin "${SKILLS_COMMIT}"; git checkout -q FETCH_HEAD
  echo "${SKILLS_COMMIT}" > .harness-commit; cd ..
fi
[ -f upstream/skills/remotion-best-practices/SKILL.md ] || { echo "miss upstream/skills/remotion-best-practices/SKILL.md"; exit 1; }
echo "ok   skills: $(ls upstream/skills | tr '\n' ' ')"
