#!/usr/bin/env bash
# Runs once at install, cwd = the install dir. Fetches CircuitJS1 into upstream/ (gitignored): the
# static half from a pinned source tarball, the compiled GWT module from the project's own CI build.
# Nothing global, nothing vendored in git, nothing compiled here. See VERSIONS for what and why.
set -euo pipefail
cd "$(dirname "$0")/.."
root=$PWD
# shellcheck disable=SC1091
. ./VERSIONS

command -v curl >/dev/null 2>&1 || { echo "miss curl on PATH"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "miss node >= 18 on PATH (the pane is a node server)"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "miss python3 (the verdict)"; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "miss tar on PATH"; exit 1; }

war=$root/upstream/war
tmp=$(mktemp -d "${TMPDIR:-/tmp}/circuitjs1.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

get() { # url dest
  curl -fsSL --retry 3 --connect-timeout 20 --max-time 300 -o "$2" "$1" \
    || { echo "miss could not fetch $1"; exit 1; }
}

echo "     circuitjs1 ${CIRCUITJS1_COMMIT:0:12} (source) + the project's CI build (compiled)"

# 1. Static files and GWT public resources, from the pinned commit.
get "$CIRCUITJS1_TARBALL" "$tmp/src.tar.gz"
tar xzf "$tmp/src.tar.gz" -C "$tmp"
src=$(find "$tmp" -maxdepth 1 -type d -name 'circuitjs1-*' | head -1)
[ -d "$src/war" ] || { echo "miss war/ in the circuitjs1 tarball"; exit 1; }

rm -rf "$root/upstream"
mkdir -p "$war/circuitjs1"
# war/ minus the servlet plumbing, the PHP relay and the service worker: the pane serves static
# files off loopback, so a worker that caches them can only ever hand back something stale.
( cd "$src/war" && tar cf - --exclude='WEB-INF' --exclude='service-worker.*' --exclude='*.php' . ) \
  | ( cd "$war" && tar xf - )
# The GWT module's public/ folder is copied into the module dir by the compiler; do the same.
cp -R "$src/src/com/lushprojects/circuitjs1/public/." "$war/circuitjs1/"
cp "$src/COPYING.txt" "$root/upstream/COPYING.txt"

# 2. The compiled module. The selection script names its own permutations; read them out of it
#    rather than pinning a list that upstream's next build would invalidate.
get "$CIRCUITJS1_BUILD/circuitjs1/circuitjs1.nocache.js" "$war/circuitjs1/circuitjs1.nocache.js"
get "$CIRCUITJS1_BUILD/circuitjs1/clear.cache.gif" "$war/circuitjs1/clear.cache.gif"
perms=$(node -e '
  const fs = require("fs");
  const js = fs.readFileSync(process.argv[1], "utf8");
  const names = new Set((js.match(/[0-9A-F]{31,32}/g) || []));
  process.stdout.write([...names].join("\n"));
' "$war/circuitjs1/circuitjs1.nocache.js")
[ -n "$perms" ] || { echo "miss no permutations named in circuitjs1.nocache.js"; exit 1; }
n=0
for p in $perms; do
  get "$CIRCUITJS1_BUILD/circuitjs1/$p.cache.js" "$war/circuitjs1/$p.cache.js"
  n=$((n + 1))
done

# The GWT theme the module injects at startup. It lives in the SDK, not in this repository's
# sources, so it only exists in the compiled output; without it the app's menus are unstyled.
mkdir -p "$war/circuitjs1/gwt/clean/images"
get "$CIRCUITJS1_BUILD/circuitjs1/gwt/clean/clean.css" "$war/circuitjs1/gwt/clean/clean.css"
for img in $(node -e '
  const css = require("fs").readFileSync(process.argv[1], "utf8");
  const set = new Set();
  for (const m of css.matchAll(/url\(\s*["\x27]?images\/([A-Za-z0-9_.-]+)["\x27]?\s*\)/g)) set.add(m[1]);
  process.stdout.write([...set].join("\n"));
' "$war/circuitjs1/gwt/clean/clean.css"); do
  get "$CIRCUITJS1_BUILD/circuitjs1/gwt/clean/images/$img" "$war/circuitjs1/gwt/clean/images/$img"
done
echo "     $n compiled permutation(s), $(ls "$war/circuitjs1/gwt/clean/images" | wc -l | tr -d ' ') theme images, $(ls "$war/circuitjs1/circuits" | wc -l | tr -d ' ') example circuits"

# 3. What landed, so doctor can tell and a human can audit.
( cd "$root/upstream" && find . -type f | LC_ALL=C sort | xargs shasum -a 256 ) > "$root/upstream/MANIFEST"
{
  echo "commit=$CIRCUITJS1_COMMIT"
  echo "build=$CIRCUITJS1_BUILD"
  echo "permutations=$n"
  echo "fetchedAt=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$root/upstream/INSTALLED"

for f in circuitjs.html lz-string.min.js circuitjs1/circuitjs1.nocache.js circuitjs1/setuplist.txt circuitjs1/gwt/clean/clean.css; do
  [ -s "$war/$f" ] || { echo "miss upstream/war/$f after fetch"; exit 1; }
done
python3 -c "import json,sys; json.dumps(1)" >/dev/null
echo "ok   circuitjs1 ${CIRCUITJS1_COMMIT:0:12} · $(du -sh "$root/upstream" | cut -f1) in upstream/ · GPL-2.0 (LICENSE-circuitjs1)"
echo "ok   node $(node -v) · $(python3 --version)"
