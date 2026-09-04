#!/usr/bin/env bash
# The version label a LOCAL, unpublished build wears — shared by every script that makes one.
#
# `<published-core>-dev.<sha>[.dirty]`. Two properties, both deliberate:
#
#   * The core matches the current release, so `harness version` and `harness status` read sensibly
#     next to a production install, and semverGt() (lib/selfUpdate.ts) — which compares the X.Y.Z core
#     only and is false on equality — can never let the release you are level with overwrite your
#     build. The NEXT real release still lands, which is the behaviour you want.
#   * The `-dev.<sha>` suffix makes it unmistakably local, and `.dirty` says the tree had uncommitted
#     changes when it was bundled — the difference between "this is commit abc123" and "this is
#     something only my disk has ever seen".
#
# It lives here rather than inside install-cli.sh because more than one script now builds the same
# bytes: the local install and the Docker remote-machine rig. Two copies of this would drift, and the
# symptom would be two boxes reporting different versions for identical code — precisely the
# confusion a two-machine test cannot afford.

# Print the label for the adapter package at $1. Never fails: every lookup degrades to something
# printable, because refusing to name a build is worse than naming it conservatively.
harness_build_label() {
  local adapter_dir="$1"
  local bucket="${GCS_BUCKET:-s3-autonomous-upgrade-3}"
  local base_url="${GCS_PUBLIC_BASE_URL:-https://storage.googleapis.com/${bucket}}"
  local metadata_path="${METADATA_PATH:-harness/cli/metadata.json}"
  local ota_key="${OTA_KEY:-cli}"   # must match ADAPTER_UPDATE_KEY in src/config/env.ts
  local meta_url="${base_url%/}/${metadata_path#/}"

  # The published core, straight from the release manifest the self-updater reads.
  local core
  core="$(curl -fsSL --max-time 6 "$meta_url" 2>/dev/null | node -e '
let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
  try { process.stdout.write(String((JSON.parse(s)[process.argv[1]]||{}).version||"")) } catch { process.stdout.write("") }
})' "$ota_key" 2>/dev/null || true)"
  if [ -z "$core" ]; then
    core="$(node -p "require('$adapter_dir/package.json').version" 2>/dev/null || echo '0.0.0')"
    echo ">> manifest unreachable — labelling against package.json: $core" >&2
  fi

  local sha dirty=""
  sha="$(git -C "$adapter_dir" rev-parse --short HEAD 2>/dev/null || echo nogit)"
  # --porcelain, not `diff --quiet`: an UNTRACKED new source file changes the bundle too. dist/ is
  # gitignored, so bundling never makes the next run look dirty by itself.
  [ -z "$(git -C "$adapter_dir" status --porcelain -- "$adapter_dir" 2>/dev/null)" ] || dirty=".dirty"

  printf '%s-dev.%s%s' "$core" "$sha" "$dirty"
}
